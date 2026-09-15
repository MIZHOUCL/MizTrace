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
import { collectWorkingCopy, findWorkingCopies, svnAvailable } from './collect/svn.js';
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

/**
 * 把一个仓库的 Git 结果按显式子项目根拆开。
 * commit 同时命中多个子项目时仍归父项目，避免同一提交重复出现。
 */
export function routeGitResult(repo, result, resolveProject) {
  const parentId = resolveProject(repo) ?? projectIdOf(repo);
  const routeForPath = (relativePath) => resolveProject(path.join(repo, relativePath));
  const buckets = new Map([[parentId, { ...result, commits: [], dirty: [], arrival: result.arrival }]]);
  for (const c of result.commits) {
    const ids = [...new Set(c.files.map((f) => routeForPath(f)).filter((id) => id && id !== parentId))];
    const id = ids.length === 1 ? ids[0] : parentId;
    if (!buckets.has(id)) buckets.set(id, { ...result, commits: [], dirty: [], arrival: null });
    buckets.get(id).commits.push(c);
  }
  for (const d of result.dirty) {
    const id = routeForPath(d.path) ?? parentId;
    if (!buckets.has(id)) buckets.set(id, { ...result, commits: [], dirty: [], arrival: null });
    buckets.get(id).dirty.push(d);
  }
  return [...buckets.entries()]
    .map(([projectId, routed]) => ({ projectId, result: routed }))
    .filter(({ result: routed }) => routed.commits.length || routed.dirty.length || routed.arrival);
}

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

  // 采集过程中的失败、以及「仓库太多已截断」都攒到这里，最后一起打印
  const gitWarnings = [];
  const repos = gitAvailable() ? findRepos(cfg.roots, 4, gitWarnings) : [];

  // SVN 工作副本（可选来源，默认关闭）。关掉的原因不是难做，而是 svn log 会访问版本库服务器，
  // 和「默认不联网」的承诺冲突 —— 详见 config.js 里的 svn 段。
  const svnOn = cfg.svn?.enabled === true && !flags['no-svn'];
  const svnReady = svnOn && svnAvailable();
  // 发现工作副本是纯文件系统遍历，不需要 svn 命令；但也**不能无条件跑**：
  // 实测有人把扫描目录配成整个盘（C:\ D:\ E:\），无条件跑等于每次白扫三遍全盘。
  // 所以只在「SVN 开着」或「一个 git 仓库都没找到（这时才需要靠它给提示）」时才走这一趟。
  const svnFound = svnOn || !repos.length ? findWorkingCopies(cfg.roots, cfg.svn?.maxDepth ?? 4) : [];
  // 同一个目录既被 git 找到又被 SVN 找到时只按 git 处理，避免同一个路径建出两个项目
  const gitRootKeys = new Set(repos.map(rootKey));
  const svnCandidates = svnFound.filter((wc) => !gitRootKeys.has(rootKey(wc)));
  const workingCopies = svnReady ? svnCandidates : [];
  if (svnOn && !svnReady) {
    process.stderr.write(
      'SVN 采集已开启，但没有找到 svn 命令。\n' +
        'Windows 上装 TortoiseSVN 时勾上 command line client tools，或单独装一个 SVN 命令行客户端，并确保它在 PATH 中。\n' +
        (svnCandidates.length ? `（已发现 ${svnCandidates.length} 个 SVN 工作副本，装上命令就能采集。）\n` : '') +
        '\n',
    );
  }

  if (!repos.length && !workingCopies.length && !flags.json) {
    // 什么都没采到时，顺便说清 SVN 那边的状况：有工作副本却没采到，用户需要知道开关在哪
    const svnNote = !svnCandidates.length
      ? ''
      : svnOn
        ? `\n另外发现 ${svnCandidates.length} 个 SVN 工作副本，但没找到 svn 命令，装上才能采集。\n`
        : `\n另外发现 ${svnCandidates.length} 个 SVN 工作副本（${svnCandidates.slice(0, 3).join('、')}${svnCandidates.length > 3 ? ' 等' : ''}）。\n` +
          'SVN 采集默认关闭，因为它比 git 多一步：svn log 是向版本库服务器发起的查询，会联网。\n' +
          '想采集就在 config.json 里把 svn.enabled 改成 true（只想记录本地未提交改动、不想联网，再加 "remote": false）。\n';
    process.stderr.write(
      `提示：以下目录里没有找到 git 仓库${svnCandidates.length ? '' : '或 SVN 工作副本'}，所以这份日志不含任何 commit 证据。\n${cfg.roots.map((r) => `  ${r}`).join('\n')}\n` +
        `把 --root 指向你真正写代码的目录（可重复），例如：\n` +
        `  miztrace today --root ~/code --root ~/work\n` +
        `或者跑一次 miztrace init，把目录写进 config.json 的 roots，以后就不用带参数了。\n` +
        svnNote +
        '\n',
    );
  }
  const { sessions, report } = collectSessions(cfg.sessionDirs, range, cfg.cutoffHour, { replies: cfg.sessions?.replies !== false, roots: cfg.roots });

  // 文件系统扫描：仓库外的改动由它负责，仓库内的交给 git，避免重复计数（ADR-019）
  const fileScanOn = cfg.fileScan?.enabled !== false && !flags['no-files'];
  const fileScan = fileScanOn
    ? scanFiles(cfg.roots, range, {
        // 版本库里的改动交给 git / SVN 采集，文件扫描只管仓库外的，避免同一个文件被记两遍（ADR-019）
        repos: [...repos, ...workingCopies],
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
  const projects = buildProjects([...repos, ...workingCopies], sessions, {
    rules: cfg.rules,
    projectRules: cfg.projectRules,
    extraDirs: [...new Set([...fileScan.hits.map((h) => projectDirOf(h.path, cfg.roots)), ...shellDirs.map((d) => repoOf(d) || projectDirOf(d, cfg.roots)), ...actionDirs])],
  });

  const gitByProject = new Map();
  const resolveProject = makeResolver(projects);
  const isToday = range.localDate === todayLocalDate(cfg.cutoffHour);
  let outlineBudget = MAX_OUTLINE_READS - outlineStats.read;
  // git 仓库与 SVN 工作副本走同一条循环：两者采集出来的 commits / dirty 形状一致，
  // 归因（routeGitResult）、模块聚合、事实构建都能共用一套。
  // 所以 gitByProject 里可能混着 SVN 的结果 —— 名字保留是为了不动下游。
  const vcsTargets = [
    ...repos.map((dir) => ({ dir, vcs: 'git' })),
    ...workingCopies.map((dir) => ({ dir, vcs: 'svn' })),
  ];
  for (const { dir, vcs } of vcsTargets) {
    const result =
      vcs === 'svn'
        ? collectWorkingCopy(dir, range, { authorFilter: cfg.authorFilter, remote: cfg.svn?.remote !== false, limit: cfg.svn?.maxRevisions ?? 500 })
        : collectRepo(dir, range, { authorFilter: cfg.authorFilter });
    if (vcs === 'git') result.dirty = filterNestedRepoStatus(dir, result.dirty, repos);
    gitWarnings.push(...(result.warnings ?? []));
    // 未提交改动属于「现在」，生成过去某天的日志时不能算进去
    if (!isToday) result.dirty = [];
    if (outlineOn && result.dirty.length && outlineBudget > 0) {
      const st = attachOutlines(result.dirty, (d) => path.join(dir, d.path), outlineBudget);
      outlineBudget -= st.read;
      outlineStats.read += st.read;
      outlineStats.found += st.found;
    }
    for (const routed of routeGitResult(dir, result, resolveProject)) {
      if (!gitByProject.has(routed.projectId)) gitByProject.set(routed.projectId, []);
      gitByProject.get(routed.projectId).push(routed.result);
    }
  }
  if (gitWarnings.length && !flags.json) {
    process.stderr.write(`版本库采集有 ${gitWarnings.length} 处失败（证据可能不完整）：\n${gitWarnings.slice(0, 5).map((w) => `  ${w}`).join('\n')}\n\n`);
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
    workingCopies,
    svnOn,
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

function rootKey(rootPath) {
  const resolved = path.resolve(rootPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function uniquePersistedId(base, used) {
  let id = base || 'unknown';
  let n = 2;
  while (used.has(id)) {
    id = `${base}-${n}`;
    n += 1;
  }
  return id;
}

function remapGrouped(source, remapId) {
  const target = new Map();
  for (const [id, values] of source ?? []) {
    const nextId = remapId(id);
    target.set(nextId, [...(target.get(nextId) ?? []), ...values]);
  }
  return target;
}

/**
 * root_path 是跨运行的项目身份。发现同一路径已有旧 id 时复用旧 id，
 * 并同步改写本次采集的全部分组，避免历史证据失联或同一路径重复建项目。
 */
function reconcileProjectIds(db, ctx) {
  const existing = db.prepare('SELECT id, name, root_path, user_renamed FROM projects WHERE root_path IS NOT NULL').all();
  const byRoot = new Map(existing.map((row) => [rootKey(row.root_path), row]));
  const usedIds = new Set(existing.map((row) => row.id));
  const aliases = new Map();

  for (const project of ctx.projects) {
    const originalId = project.id;
    const stored = byRoot.get(rootKey(project.rootPath));
    if (stored) {
      project.id = stored.id;
      project.rootPath = stored.root_path;
      if (stored.user_renamed) {
        project.name = stored.name;
        project.userRenamed = true;
      }
    } else {
      project.id = uniquePersistedId(originalId, usedIds);
      usedIds.add(project.id);
      byRoot.set(rootKey(project.rootPath), { id: project.id, root_path: project.rootPath });
    }
    aliases.set(originalId, project.id);
  }

  const remapId = (id) => aliases.get(id) ?? id;
  for (const session of ctx.sessions) session.projectId = remapId(session.projectId);
  ctx.gitByProject = remapGrouped(ctx.gitByProject, remapId);
  ctx.sessionsByProject = remapGrouped(ctx.sessionsByProject, remapId);
  ctx.filesByProject = remapGrouped(ctx.filesByProject, remapId);
  ctx.shellByProject = remapGrouped(ctx.shellByProject, remapId);
  const projectIdForFile = ctx.projectIdForFile;
  const projectIdForShell = ctx.projectIdForShell;
  ctx.projectIdForFile = (filePath) => remapId(projectIdForFile(filePath));
  ctx.projectIdForShell = (command) => remapId(projectIdForShell(command));
}

function persistProjects(db, ctx, nowIso) {
  reconcileProjectIds(db, ctx);
  const stmt = db.prepare(
    `INSERT INTO projects (id, name, root_path, user_renamed, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (root_path) DO UPDATE SET
       name = CASE WHEN projects.user_renamed = 1 THEN projects.name ELSE excluded.name END,
       user_renamed = MAX(projects.user_renamed, excluded.user_renamed)`,
  );
  for (const p of ctx.projects) stmt.run(p.id, p.name, p.rootPath, p.userRenamed ? 1 : 0, nowIso);
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
  persistProjects(db, ctx, ctx.nowIso);
  const { nowIso, sessions, fileScan, projects, gitByProject, sessionsByProject, filesByProject, shellByProject, projectIdForFile, projectIdForShell, web, shell } = ctx;

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
