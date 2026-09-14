/**
 * 一天的数据流水线，CLI 与本地服务共用：
 *   采集（git / 文件 / 会话 / 浏览器）→ 归因 → 落库 → 聚成模块 → 套用用户选择 → 返回。
 * 之前这些散在 cli.js 里，服务端要复用就必须抽出来。
 */
import fs from 'node:fs';
import path from 'node:path';
import { dataDir, syncDirWarning } from './config.js';
import { todayLocalDate } from './time.js';
import { upsertEvidence, getDayState } from './db.js';
import { findRepos, collectRepo, filterNestedRepoStatus, gitAvailable, repoOf } from './collect/git.js';
import { collectSessions } from './collect/sessions.js';
import { scanFiles, projectDirOf, projectRootOf } from './collect/files.js';
import { readOutline, supportsOutline } from './collect/outline.js';
import { collectBrowser } from './collect/browser.js';
import { collectShell, shellLogPath } from './collect/shell.js';
import { buildProjects, attributeSession, projectIdOf, makeResolver } from './attribute.js';
import { evidenceFromGit, evidenceFromSession, evidenceFromFiles, evidenceFromWeb, evidenceFromShell, evidenceFromNotes, sourceId } from './facts.js';
import { buildModules } from './modules.js';

/** 一次运行最多读多少个文档的大纲：够一天的量，又不至于让一个塞满文档的目录拖慢采集。 */
const MAX_OUTLINE_READS = 300;

/** 给文件条目补大纲（就地改 hit.outline）。返回统计。 */
function attachOutlines(hits, pathOf, budget) {
  const stats = { read: 0, found: 0 };
  for (const h of hits) {
    if (stats.read >= budget) break;
    const p = pathOf(h);
    if (!p || !supportsOutline(p)) continue;
    stats.read += 1;
    const outline = readOutline(p);
    if (outline) {
      h.outline = outline;
      stats.found += 1;
    }
  }
  return stats;
}

/** 采集：git / 文件扫描 / AI 会话 / 浏览器 → 项目归因。只读，不落库。 */
export function collectAll(cfg, range, flags) {
  const nowIso = new Date().toISOString();
  const warn = syncDirWarning();
  if (warn && !flags.json) process.stderr.write(`警告：${warn}\n`);
  if (!gitAvailable()) {
    process.stderr.write('未找到 git 命令。Windows 上请安装 Git for Windows 并确保它在 PATH 中。\n');
    process.stderr.write('（仍会继续采集 AI 会话，只是没有 commit 证据。）\n');
  }

  const repos = gitAvailable() ? findRepos(cfg.roots) : [];
  if (!repos.length && !flags.json) {
    process.stderr.write(
      `提示：以下目录里没有找到 git 仓库，所以这份日志不含任何 commit 证据。\n${cfg.roots.map((r) => `  ${r}`).join('\n')}\n` +
        `把 --root 指向你真正写代码的目录（可重复），例如：\n` +
        `  miztrace today --root ~/code --root ~/work\n` +
        `或者跑一次 miztrace init，把目录写进 config.json 的 roots，以后就不用带参数了。\n\n`,
    );
  }
  const { sessions, report } = collectSessions(cfg.sessionDirs, range, cfg.cutoffHour, { replies: cfg.sessions?.replies !== false, roots: cfg.roots });

  // 文件系统扫描：仓库外的改动由它负责，仓库内的交给 git，避免重复计数（ADR-019）
  const fileScanOn = cfg.fileScan?.enabled !== false && !flags['no-files'];
  const fileScan = fileScanOn
    ? scanFiles(cfg.roots, range, {
        repos,
        maxDepth: cfg.fileScan?.maxDepth ?? 6,
        maxFiles: cfg.fileScan?.maxFiles ?? 5000,
        extraExcludes: cfg.fileScan?.extraExcludes ?? [],
        mode: cfg.fileScan?.mode ?? 'worklike',
        extraExtensions: cfg.fileScan?.extraExtensions ?? [],
        excludePaths: [cfg.out, dataDir()],
      })
    : { hits: [], stats: { scanned: 0, dirs: 0, skippedInRepo: 0, skippedSensitive: 0, skippedNoise: 0, truncated: false } };
  if (!flags.json && fileScanOn) {
    const s = fileScan.stats;
    if (s.truncated) {
      process.stderr.write(`文件扫描达到上限 ${cfg.fileScan?.maxFiles ?? 5000} 个，结果已截断。调大 config.json 的 fileScan.maxFiles 可放宽。\n`);
    }
    if (s.skippedSensitive) process.stderr.write(`已跳过 ${s.skippedSensitive} 个疑似敏感文件（连路径都不记录）。\n`);
    if (s.skippedNoise) process.stderr.write(`已过滤 ${s.skippedNoise} 个非工作产物（应用状态、临时文件、安装包等）。\n`);
  }

  // 文档大纲（ADR-022）：只读标题层级 / 工作表名 / 幻灯片标题，不读正文
  const outlineOn = fileScanOn && cfg.fileScan?.outline !== false;
  const outlineStats = outlineOn ? attachOutlines(fileScan.hits, (h) => h.path, MAX_OUTLINE_READS) : { read: 0, found: 0 };

  // 浏览器历史（ADR-022）：默认关闭；开了也只记标题、去参数的地址、时间、搜索词
  const browserOn = cfg.browser?.enabled === true && !flags['no-browser'];
  const web = browserOn
    ? collectBrowser(range, { excludeDomains: cfg.browser?.excludeDomains ?? [], only: cfg.browser?.only ?? [], maxPages: cfg.browser?.maxPages ?? 500 })
    : { pages: [], visits: [], report: [], stats: { visits: 0, pages: 0, truncated: false } };
  if (!flags.json && browserOn) {
    for (const r of web.report) {
      if (r.status !== 'ok') process.stderr.write(`浏览器 ${r.name}（${r.profile}）未读取：${r.error ?? r.status}\n`);
    }
  }

  // 终端命令（ADR-023）：默认关闭；开了也只读 MizTrace 自己的钩子日志，不读输出
  const shellOn = cfg.shell?.enabled === true && !flags['no-shell'];
  const shell = shellOn ? collectShell(range, { file: shellLogPath(cfg) }) : { commands: [], stats: { total: 0, skippedCredential: 0, exists: false } };
  if (!flags.json && shellOn && !shell.stats.exists) {
    process.stderr.write(`终端记录已开启，但还没有日志：${shellLogPath(cfg)}\n先跑 miztrace shell-hook --install 装上钩子，再开一个新终端。\n`);
  }

  // 终端命令所在的目录也算项目候选：在 D:\wecom 里敲了一下午命令，它就该是一条道
  const shellDirs = [...new Set(shell.commands.map((c) => c.cwd).filter((d) => d && path.isAbsolute(d)))];
  const actionDirs = sessions.flatMap((s) => {
    s.actionProjectRoots = [...new Set((s.actions ?? []).filter((a) => a.kind === 'file').map((a) => projectRootOf(a.value)).filter(Boolean))];
    return s.actionProjectRoots;
  });
  const projects = buildProjects(repos, sessions, {
    rules: cfg.rules,
    projectRules: cfg.projectRules,
    extraDirs: [...new Set([...fileScan.hits.map((h) => projectDirOf(h.path, cfg.roots)), ...shellDirs.map((d) => repoOf(d) || projectDirOf(d, cfg.roots)), ...actionDirs])],
  });

  const gitByProject = new Map();
  const resolveProject = makeResolver(projects);
  const routeForPath = (repo, relativePath) => resolveProject(path.join(repo, relativePath));
  const routeGitResult = (repo, result) => {
    const parentId = resolveProject(repo) ?? projectIdOf(repo);
    const buckets = new Map([[parentId, { ...result, commits: [], dirty: [], arrival: result.arrival }]]);
    for (const c of result.commits) {
      const ids = [...new Set(c.files.map((f) => routeForPath(repo, f)).filter((id) => id && id !== parentId))];
      const id = ids.length === 1 ? ids[0] : parentId;
      if (!buckets.has(id)) buckets.set(id, { ...result, commits: [], dirty: [], arrival: null });
      buckets.get(id).commits.push(c);
    }
    for (const d of result.dirty) {
      const id = routeForPath(repo, d.path) ?? parentId;
      if (!buckets.has(id)) buckets.set(id, { ...result, commits: [], dirty: [], arrival: null });
      buckets.get(id).dirty.push(d);
    }
    return [...buckets.values()].filter((r) => r.commits.length || r.dirty.length || r.arrival);
  };
  const isToday = range.localDate === todayLocalDate(cfg.cutoffHour);
  const gitWarnings = [];
  let outlineBudget = MAX_OUTLINE_READS - outlineStats.read;
  for (const repo of repos) {
    const result = collectRepo(repo, range, { authorFilter: cfg.authorFilter });
    result.dirty = filterNestedRepoStatus(repo, result.dirty, repos);
    gitWarnings.push(...(result.warnings ?? []));
    // 未提交改动属于「现在」，生成过去某天的日志时不能算进去
    if (!isToday) result.dirty = [];
    if (outlineOn && result.dirty.length && outlineBudget > 0) {
      const st = attachOutlines(result.dirty, (d) => path.join(repo, d.path), outlineBudget);
      outlineBudget -= st.read;
      outlineStats.read += st.read;
      outlineStats.found += st.found;
    }
    for (const routed of routeGitResult(repo, result)) {
      const id = resolveProject(routed.repo) ?? projectIdOf(routed.repo);
      if (!gitByProject.has(id)) gitByProject.set(id, []);
      gitByProject.get(id).push(routed);
    }
  }
  if (gitWarnings.length && !flags.json) {
    process.stderr.write(`git 采集有 ${gitWarnings.length} 处失败（证据可能不完整）：\n${gitWarnings.slice(0, 5).map((w) => `  ${w}`).join('\n')}\n\n`);
  }

  const sessionsByProject = new Map();
  for (const s of sessions) {
    const actionPid = (s.actions ?? []).map((a) => (a.kind === 'file' ? resolveProject(a.value) : null)).find(Boolean);
    let pid = attributeSession(s, projects) ?? actionPid ?? resolveProject(s.cwd);
    if (!pid) {
      const owner = repoOf(s.cwd) || s.cwd;
      pid = resolveProject(owner) ?? projectIdOf(owner);
    }
    s.projectId = pid;
    if (!sessionsByProject.has(pid)) sessionsByProject.set(pid, []);
    sessionsByProject.get(pid).push(s);
  }

  const shellByProject = new Map();
  const projectIdForShell = (c) => {
    const owner = repoOf(c.cwd) || projectDirOf(c.cwd, cfg.roots);
    return resolveProject(owner) ?? resolveProject(c.cwd) ?? projectIdOf(owner);
  };
  for (const c of shell.commands) {
    const pid = projectIdForShell(c);
    if (!shellByProject.has(pid)) shellByProject.set(pid, []);
    shellByProject.get(pid).push(c);
  }

  const filesByProject = new Map();
  const projectIdForFile = (p) => {
    const dir = projectDirOf(p, cfg.roots);
    return resolveProject(dir) ?? projectIdOf(dir);
  };
  for (const h of fileScan.hits) {
    const pid = projectIdForFile(h.path);
    if (!filesByProject.has(pid)) filesByProject.set(pid, []);
    filesByProject.get(pid).push(h);
  }

  return {
    nowIso,
    repos,
    sessions,
    report,
    fileScan,
    fileScanOn,
    outlineOn,
    outlineStats,
    browserOn,
    web,
    shellOn,
    shell,
    projects,
    gitByProject,
    sessionsByProject,
    filesByProject,
    shellByProject,
    projectIdForFile,
    projectIdForShell,
  };
}

function persistProjects(db, projects, nowIso) {
  const stmt = db.prepare(
    `INSERT INTO projects (id, name, root_path, user_renamed, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET name = excluded.name, root_path = excluded.root_path`,
  );
  for (const p of projects) stmt.run(p.id, p.name, p.rootPath, p.userRenamed ? 1 : 0, nowIso);
}

function persistCommits(db, result, projectId) {
  const stmt = db.prepare(
    `INSERT INTO commits (hash, project_id, message, author, committed_at, branch, files, additions, deletions)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (hash) DO NOTHING`,
  );
  for (const c of result.commits) {
    stmt.run(c.hash, projectId, c.message, c.author ?? null, c.committedAt, result.branch, c.files.length, c.additions, c.deletions);
  }
}

function persistSession(db, s) {
  db.prepare(
    `INSERT INTO sessions (id, provider_id, thread_id, title, cwd, git_branch, project_id, first_ts, last_ts, content_status, schema_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET title = COALESCE(excluded.title, sessions.title),
       last_ts = excluded.last_ts, project_id = excluded.project_id`,
  ).run(
    `${s.providerId}:${s.sessionId}`,
    s.providerId,
    s.threadId ?? s.sessionId,
    s.title ?? null,
    s.cwd ?? null,
    s.gitBranch ?? null,
    s.projectId ?? null,
    s.firstTs ?? null,
    s.lastTs ?? null,
    'summary_imported',
    s.schemaVersion ?? null,
  );
}

function persistJournal(db, localDate, markdown, nowIso, outPath) {
  db.prepare(
    `INSERT INTO journals (id, local_date, markdown, out_path, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (local_date) DO UPDATE SET markdown = excluded.markdown,
       out_path = excluded.out_path, updated_at = excluded.updated_at`,
  ).run(`journal:${localDate}`, localDate, markdown, outPath ?? null, nowIso, nowIso);
}

/**
 * 把 Markdown 写到 --out 目录。
 * @param {string} fileStem 文件名主干，单日就是 YYYY-MM-DD，周汇总是 YYYY-MM-DD-week
 */
export function writeOut(cfg, fileStem, markdown, flags) {
  const dir = cfg.out;
  if (!dir) return null;
  const target = path.join(dir, `${fileStem}.md`);
  fs.mkdirSync(dir, { recursive: true });
  const next = `${markdown}\n`;
  if (fs.existsSync(target)) {
    // 内容一字未变就什么都不做：同一天反复运行是常态，不能每跑一次就往日记目录里堆一个 .bak
    let current = null;
    try {
      current = fs.readFileSync(target, 'utf8');
    } catch {
      current = null;
    }
    if (current === next) return target;
    // 内容变了才在覆盖前做带时间戳的备份，保住用户手写内容
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(target, `${target}.${stamp}.bak`);
  }
  fs.writeFileSync(target, next, 'utf8');
  if (!flags.json) process.stderr.write(`已写入 ${target}\n`);
  return target;
}

/** 永久排除规则：项目名 / 项目 id / rootPath 子串，任一匹配即排除。 */
export function matchesExcludeProjects(module, projects, excludeProjects) {
  if (!excludeProjects?.length) return false;
  const p = projects.find((x) => x.id === module.projectId);
  const hay = [module.projectName, module.projectId, p?.rootPath].filter(Boolean).map(String);
  return excludeProjects.some((rule) => {
    const r = String(rule ?? '').trim();
    return r && hay.some((h) => h === r || h.includes(r));
  });
}

/**
 * 套用用户选择：默认值 → 永久排除 → 当天的手动 overrides（优先级最高）。
 * 就地修改 module.selected，并标注来源，前端好解释「为什么它是灰的」。
 */
export function applySelection(modules, overrides, excludeProjects, projects) {
  for (const m of modules) {
    // 可以对同一批模块反复套用（服务端复用采集结果时就是这样）：默认值只记第一次的，之后每次都从它算起
    if (m.defaultSelected === undefined) m.defaultSelected = m.selected;
    m.selected = m.defaultSelected;
    m.permanentlyExcluded = matchesExcludeProjects(m, projects, excludeProjects);
    if (m.permanentlyExcluded) m.selected = false;
    if (overrides && Object.prototype.hasOwnProperty.call(overrides, m.key)) {
      m.selected = Boolean(overrides[m.key]);
      m.overridden = true;
    } else {
      m.overridden = false;
    }
  }
  return modules;
}

/**
 * 跑完一天：采集 → 落库 → 模块 → 选择。
 * @param {any} cfg
 * @param {{localDate:string,startUtc:string,endUtc:string}} range
 * @param {any} flags 至少含 json / 'no-files'
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ctx?:any}} [opts] ctx = 上一次 collectAll 的结果。采集是整条流水线里唯一慢的一步
 *   （扫几千个目录、复制浏览器历史、逐个仓库跑 git），本地服务把它缓存起来，
 *   预览 / 生成 / 规则版日记就不必各自再扫一遍；落库、聚模块、套选择每次照做，所以手记、勾选总是最新的。
 */
export function buildDay(cfg, range, flags, db, opts = {}) {
  const ctx = opts.ctx ?? collectAll(cfg, range, flags);
  const { nowIso, sessions, fileScan, projects, gitByProject, sessionsByProject, filesByProject, shellByProject, projectIdForFile, projectIdForShell, web, shell } = ctx;

  persistProjects(db, projects, nowIso);
  const evidenceIndex = new Map();
  for (const [pid, results] of gitByProject) {
    for (const r of results) {
      persistCommits(db, r, pid);
      for (const row of evidenceFromGit(r, pid, cfg.cutoffHour, nowIso)) {
        upsertEvidence(db, row);
        evidenceIndex.set(sourceId(row.source_type, row.source_ref), row);
      }
    }
  }
  for (const s of sessions) {
    persistSession(db, s);
    for (const row of evidenceFromSession(s, s.projectId, cfg.cutoffHour)) {
      upsertEvidence(db, row);
      evidenceIndex.set(sourceId(row.source_type, row.source_ref), row);
    }
  }
  for (const row of evidenceFromFiles(fileScan.hits, projectIdForFile, cfg.cutoffHour)) {
    upsertEvidence(db, row);
    evidenceIndex.set(sourceId(row.source_type, row.source_ref), row);
  }
  for (const row of evidenceFromWeb(web.pages, cfg.cutoffHour)) {
    upsertEvidence(db, row);
    evidenceIndex.set(sourceId(row.source_type, row.source_ref), row);
  }
  for (const row of evidenceFromShell(shell.commands, projectIdForShell, cfg.cutoffHour)) {
    upsertEvidence(db, row);
    evidenceIndex.set(sourceId(row.source_type, row.source_ref), row);
  }

  const dayState = getDayState(db, range.localDate);
  for (const row of evidenceFromNotes(dayState.notes, range.localDate, cfg.cutoffHour)) {
    upsertEvidence(db, row);
    evidenceIndex.set(sourceId(row.source_type, row.source_ref), row);
  }

  const modules = buildModules(
    { projects, gitByProject, sessionsByProject, filesByProject, shellByProject, nowIso, webVisits: web.visits, notes: dayState.notes },
    { gapMinutes: cfg.gapMinutes, webGapMinutes: cfg.browser?.gapMinutes, localDate: range.localDate },
  );
  applySelection(modules, dayState.overrides, cfg.excludeProjects, projects);

  return { localDate: range.localDate, range, ctx, modules, evidenceIndex, dayState };
}

/** 保存日记：写 --out 目录（先备份旧文件）+ journals 表。 */
export function saveJournal(db, cfg, localDate, markdown, nowIso = new Date().toISOString()) {
  const outPath = writeOut(cfg, localDate, markdown, { json: true });
  persistJournal(db, localDate, markdown, nowIso, outPath);
  return outPath;
}
