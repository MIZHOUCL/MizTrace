/**
 * 事实构建与引用完整性校验（ADR-006，本项目唯一的差异点）。
 *
 * 三态：
 *  confirmed  —— 每个 source_id 都指向真实存在的证据行，且文字可由该证据直接支撑
 *  inferred   —— 由规则或模型归纳，来源存在但表述超出原文
 *  unverified —— 无法关联到任何证据
 */
import path from 'node:path';
import { localDateOf } from './time.js';
import { evidenceExists } from './db.js';
import { outlineText } from './collect/outline.js';

/** source_id 形如 "commit:<hash>" / "session:<sid>#<idx>"，只按第一个冒号切分。 */
export function parseSourceId(sourceId) {
  const i = sourceId.indexOf(':');
  if (i < 0) return null;
  return { sourceType: sourceId.slice(0, i), sourceRef: sourceId.slice(i + 1) };
}

export function sourceId(sourceType, sourceRef) {
  return `${sourceType}:${sourceRef}`;
}

/** 会话标题在要点里只显示前 40 字，完整原文留在脚注里。 */
export function shortLabel(text, max = 40) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 单个会话最多逐条列出多少条提问，其余折叠成一行。 */
export const MAX_PROMPTS_SHOWN = 12;

/** 单个项目最多逐个列出多少个改动文件，其余折叠成一行。 */
export const MAX_FILES_SHOWN = 15;

/** git / SVN 采集结果 → 证据行。两者形状一致，各自的证据类型由采集阶段写在条目上。 */
export function evidenceFromGit(repoResult, projectId, cutoffHour, nowIso) {
  const rows = [];
  const commitType = repoResult.vcs === 'svn' ? 'svn-commit' : 'commit';
  const dirtyType = repoResult.vcs === 'svn' ? 'svn-worktree' : 'worktree';
  if (repoResult.arrival) {
    rows.push({
      source_type: 'clone',
      source_ref: repoResult.repo,
      project_id: projectId,
      path: repoResult.repo,
      path_alias: baseName(repoResult.repo),
      occurred_at: repoResult.arrival.at,
      local_date: localDateOf(repoResult.arrival.at, cutoffHour),
      level: 'L0',
      excerpt: repoResult.arrival.remote ?? '',
    });
  }
  for (const c of repoResult.commits) {
    rows.push({
      source_type: c.sourceType ?? commitType,
      source_ref: c.hash,
      project_id: projectId,
      occurred_at: c.committedAt,
      local_date: localDateOf(c.committedAt, cutoffHour),
      level: 'L0',
      excerpt: c.message,
    });
  }
  for (const d of repoResult.dirty) {
    rows.push({
      source_type: d.sourceType ?? dirtyType,
      source_ref: `${projectId}:${d.path}`,
      project_id: projectId,
      path: path.join(repoResult.repo, d.path),
      path_alias: d.path,
      occurred_at: d.mtime ?? nowIso,
      local_date: localDateOf(d.mtime ?? nowIso, cutoffHour),
      level: d.outline ? 'L1' : 'L0',
      // 状态码后面跟大纲：footnoteLabel 按「｜」拆开
      excerpt: d.outline ? `${d.status}｜${outlineText(d.outline)}` : d.status,
    });
  }
  return rows;
}

/** 文件系统扫描结果 → 证据行（路径与时间；开了大纲的文档再带一行结构，仍不含正文）。 */
export function evidenceFromFiles(hits, projectIdFor, cutoffHour) {
  return hits.map((h) => ({
    source_type: 'file',
    source_ref: h.path,
    project_id: projectIdFor(h.path),
    path: h.path,
    path_alias: baseName(h.path),
    occurred_at: h.mtime,
    local_date: localDateOf(h.mtime, cutoffHour),
    level: h.outline ? 'L1' : 'L0',
    excerpt: h.outline ? outlineText(h.outline) : `${h.size} bytes${h.created ? '｜新出现' : ''}`,
  }));
}

/** 浏览记录 → 证据行。source_ref 是去掉参数的地址，同一页一天只有一行；excerpt 是标题。 */
export function evidenceFromWeb(pages, cutoffHour) {
  return (pages ?? []).map((p) => ({
    source_type: 'web',
    source_ref: p.url,
    project_id: 'web',
    path: p.url,
    path_alias: p.host,
    occurred_at: p.firstTs,
    local_date: localDateOf(p.firstTs, cutoffHour),
    level: 'L1',
    excerpt: `${p.title}${p.visits > 1 ? `｜${p.visits} 次` : ''}${p.secs >= 60 ? `｜停留约 ${Math.round(p.secs / 60)} 分钟` : ''}${p.browser ? `｜${p.browser}` : ''}`,
  }));
}

/**
 * 手记 → 证据行。每条手记一行（source_ref = `日期#条目 id`），每张图一行（source_ref = 图片 id，path 是文件）。
 * 条目 id 必须进 source_ref：一天可以有好几条手记，只用日期的话它们会塌成同一条证据。
 */
export function evidenceFromNotes(notes, localDate, cutoffHour) {
  const rows = [];
  const fallback = `${localDate}T12:00:00.000Z`;
  for (const entry of Array.isArray(notes?.entries) ? notes.entries : []) {
    const text = String(entry.text ?? '').trim();
    if (!text) continue;
    rows.push({
      source_type: 'note',
      source_ref: `${localDate}#${entry.id}`,
      project_id: 'notes',
      occurred_at: entry.ts ?? fallback,
      local_date: localDate,
      level: 'L1',
      excerpt: text,
    });
  }
  for (const im of Array.isArray(notes?.images) ? notes.images : []) {
    const ts = im.ts ?? fallback;
    rows.push({ source_type: 'image', source_ref: im.id, project_id: 'notes', path: im.path, path_alias: im.name, occurred_at: ts, local_date: localDate, level: 'L1', excerpt: im.name });
  }
  return rows;
}

/** 终端命令 → 证据行。source_ref 是「时间+目录+命令」的哈希，同一条命令一天里只有一行；path 是当时的目录。 */
export function evidenceFromShell(commands, projectIdFor, cutoffHour) {
  return (commands ?? []).map((c) => ({
    source_type: 'shell',
    source_ref: c.id,
    project_id: projectIdFor(c),
    path: c.cwd,
    path_alias: baseName(c.cwd),
    occurred_at: c.ts,
    local_date: localDateOf(c.ts, cutoffHour),
    level: 'L1',
    excerpt: c.cmd,
  }));
}

/** 会话 → 证据行。用户输入是 L1；每轮的最终回复是 L2（只有截断后的最后一段，见 ADR-022）。 */
export function evidenceFromSession(session, projectId, cutoffHour) {
  const rows = [];
  for (const p of session.prompts) {
    rows.push({
      source_type: 'session',
      source_ref: `${session.sessionId}#${p.index}`,
      project_id: projectId,
      occurred_at: p.ts,
      local_date: p.localDate ?? localDateOf(p.ts, cutoffHour),
      level: 'L1',
      excerpt: p.text,
    });
  }
  for (const r of session.replies ?? []) {
    rows.push({
      source_type: 'session-reply',
      source_ref: `${session.sessionId}#${r.index}`,
      project_id: projectId,
      occurred_at: r.ts,
      local_date: r.localDate ?? localDateOf(r.ts, cutoffHour),
      level: 'L2',
      excerpt: r.text,
    });
  }
  for (const a of session.actions) {
    rows.push({
      source_type: 'session-action',
      source_ref: `${session.sessionId}#${a.index}:${a.kind}:${a.value}`,
      project_id: projectId,
      path: a.kind === 'file' ? a.value : null,
      path_alias: a.kind === 'file' ? path.basename(a.value) : null,
      occurred_at: a.ts,
      local_date: localDateOf(a.ts, cutoffHour),
      level: 'L1',
      excerpt: `${a.kind}: ${a.value}`,
    });
  }
  return rows;
}

/**
 * 纯规则生成事实（零模型调用）。
 * @param {{projects:any[], gitByProject:Map<string,any[]>, sessionsByProject:Map<string,any[]>}} input
 * @param {string} localDate
 */
export function buildFacts(input, localDate) {
  const facts = [];
  const push = (projectId, text, ids, confidence, occurredAt, depth = 0) => {
    facts.push({
      id: `fact:${projectId}:${facts.length}`,
      project_id: projectId,
      text,
      source_ids: ids,
      confidence,
      occurred_at: occurredAt ?? null,
      local_date: localDate,
      depth,
    });
  };

  for (const project of input.projects) {
    const repoResults = input.gitByProject.get(project.id) ?? [];
    const sessions = input.sessionsByProject.get(project.id) ?? [];

    for (const r of repoResults) {
      const isSvn = r.vcs === 'svn';
      for (const c of r.commits) {
        // SVN 采集不到行数（要行数就得 svn diff 读正文，违反本项目规矩），所以它是 0 时不渲染，别写出「+0 −0」
        const lines = c.additions || c.deletions ? `，+${c.additions} −${c.deletions}` : '';
        const stat = c.files.length ? `（${c.files.length} 个文件${lines}）` : '';
        push(project.id, `${isSvn ? `SVN r${c.revision}` : ''}提交「${c.message}」${stat}`, [sourceId(c.sourceType ?? (isSvn ? 'svn-commit' : 'commit'), c.hash)], 'confirmed', c.committedAt);
      }
      if (r.dirty.length) {
        const shown = r.dirty.slice(0, 5).map((d) => d.path);
        const more = r.dirty.length > shown.length ? ` 等 ${r.dirty.length} 个` : '';
        push(
          project.id,
          `${isSvn ? '工作副本' : '工作树'}有未提交改动：${shown.join('、')}${more}`,
          r.dirty.map((d) => sourceId(d.sourceType ?? (isSvn ? 'svn-worktree' : 'worktree'), `${project.id}:${d.path}`)),
          'confirmed',
          null,
        );
      }
    }

    for (const s of sessions) {
      pushSessionFacts(push, project.id, s);
    }

    const fileHits = input.filesByProject?.get(project.id) ?? [];
    if (fileHits.length) pushFileFacts(push, project, fileHits);
  }

  if (input.webPages?.length) pushWebFacts(push, input.webPages);

  return facts;
}

/** 浏览 → 事实：概览 + 逐页（搜索在前，超出上限折叠）。 */
function pushWebFacts(push, pages) {
  const ordered = [...pages.filter((p) => p.term), ...pages.filter((p) => !p.term)];
  push('web', `浏览 ${pages.length} 个页面（${new Set(pages.map((p) => p.host)).size} 个站点）`, ordered.slice(0, 6).map((p) => sourceId('web', p.url)), 'confirmed', pages[0].firstTs, 0);
  const shown = ordered.slice(0, MAX_FILES_SHOWN);
  for (const p of shown) {
    push('web', p.term ? `搜索「${p.term}」` : `${shortLabel(p.title, 60)}（${p.host}）`, [sourceId('web', p.url)], 'confirmed', p.firstTs, 1);
  }
  if (ordered.length > shown.length) {
    const rest = ordered.slice(shown.length);
    push('web', `另有 ${rest.length} 个页面`, rest.slice(0, 20).map((p) => sourceId('web', p.url)), 'confirmed', rest[0].firstTs, 1);
  }
}

/** 文件系统改动 → 事实。概览 + 逐个文件（超出上限折叠）。 */
function pushFileFacts(push, project, hits) {
  const ids = hits.map((h) => sourceId('file', h.path));
  push(
    project.id,
    `改动 ${hits.length} 个文件（不在版本库内，按文件修改时间）`,
    ids.slice(0, 6),
    'confirmed',
    hits[0].mtime,
    0,
  );
  const shown = hits.slice(0, MAX_FILES_SHOWN);
  for (const h of shown) {
    push(project.id, relativeTo(project.rootPath, h.path), [sourceId('file', h.path)], 'confirmed', h.mtime, 1);
  }
  if (hits.length > shown.length) {
    const rest = hits.slice(shown.length);
    push(
      project.id,
      `另有 ${rest.length} 个文件（用 --json 看完整列表）`,
      rest.slice(0, 20).map((h) => sourceId('file', h.path)),
      'confirmed',
      rest[0].mtime,
      1,
    );
  }
}

/** 尽量显示相对路径，读起来短；拿不到相对关系就退回文件名。 */
function relativeTo(rootPath, filePath) {
  if (!rootPath) return baseName(filePath);
  const norm = (p) => String(p).replace(/[/\\]+$/, '');
  const root = norm(rootPath);
  if (filePath.startsWith(`${root}/`) || filePath.startsWith(`${root}\\`)) {
    return filePath.slice(root.length + 1);
  }
  return baseName(filePath);
}

/** 一个会话展开成多条事实：概览 + 每条提问 + 改动文件 + 执行命令。 */
function pushSessionFacts(push, projectId, s) {
  const providerLabel = s.providerId === 'codex' ? 'Codex' : 'Claude Code';
  const shortId = String(s.sessionId).slice(0, 8);
  // 只有 Claude Code 的 ai-title 是真标题；Codex 没有标题，不要拿用户某句话冒充
  const label = s.title ? `「${shortLabel(s.title, 50)}」` : ` \`${shortId}\``;

  const files = [...new Set(s.actions.filter((a) => a.kind === 'file').map((a) => a.value))];
  const commands = s.actions.filter((a) => a.kind === 'command');
  const searches = s.actions.filter((a) => a.kind === 'search');
  const replyOf = new Map((s.replies ?? []).map((r) => [r.promptIndex, r]));
  const overviewIds = [];
  if (s.prompts[0]) overviewIds.push(sourceId('session', `${s.sessionId}#${s.prompts[0].index}`));

  const parts = [];
  if (s.prompts.length) parts.push(`提问 ${s.prompts.length} 条`);
  if (replyOf.size) parts.push(`回复 ${replyOf.size} 条`);
  if (files.length) parts.push(`改动 ${files.length} 个文件`);
  if (commands.length) parts.push(`执行 ${commands.length} 条命令`);
  if (searches.length) parts.push(`联网搜索 ${searches.length} 次`);
  push(
    projectId,
    `${providerLabel} 会话${label}：${parts.join('、') || '无可提取内容'}`,
    overviewIds,
    overviewIds.length ? 'confirmed' : 'unverified',
    s.firstTs,
    0,
  );

  // 逐条列出用户提问 —— 这是日志的正文，不能只留第一条
  const shownPrompts = s.prompts.slice(0, MAX_PROMPTS_SHOWN);
  for (const p of shownPrompts) {
    push(projectId, shortLabel(p.text, 90), [sourceId('session', `${s.sessionId}#${p.index}`)], 'confirmed', p.ts, 1);
    const r = replyOf.get(p.index);
    if (r) push(projectId, `回复：${shortLabel(r.text, 120)}`, [sourceId('session-reply', `${s.sessionId}#${r.index}`)], 'confirmed', r.ts, 2);
  }
  if (s.prompts.length > shownPrompts.length) {
    const rest = s.prompts.slice(shownPrompts.length);
    push(
      projectId,
      `另有 ${rest.length} 条提问（用 miztrace show session:${s.sessionId}#<序号> 查看）`,
      rest.map((p) => sourceId('session', `${s.sessionId}#${p.index}`)),
      'confirmed',
      rest[0].ts,
      1,
    );
  }

  if (files.length) {
    const shown = files.slice(0, 8);
    const more = files.length > shown.length ? ` 等 ${files.length} 个` : '';
    push(
      projectId,
      `改动文件：${shown.map(baseName).join('、')}${more}`,
      s.actions.filter((a) => a.kind === 'file').slice(0, 20).map((a) => sourceId('session-action', `${s.sessionId}#${a.index}:${a.kind}:${a.value}`)),
      'confirmed',
      null,
      1,
    );
  }
  if (commands.length) {
    const shown = commands.slice(0, 5);
    const more = commands.length > shown.length ? ` 等 ${commands.length} 条` : '';
    push(
      projectId,
      `执行命令：${shown.map((c) => `\`${c.value}\``).join('、')}${more}`,
      shown.map((c) => sourceId('session-action', `${s.sessionId}#${c.index}:${c.kind}:${c.value}`)),
      'confirmed',
      null,
      1,
    );
  }
  if (searches.length) {
    const shown = searches.slice(0, 5);
    const more = searches.length > shown.length ? ` 等 ${searches.length} 次` : '';
    push(
      projectId,
      `联网搜索：${shown.map((c) => `「${c.value}」`).join('、')}${more}`,
      shown.map((c) => sourceId('session-action', `${s.sessionId}#${c.index}:${c.kind}:${c.value}`)),
      'confirmed',
      null,
      1,
    );
  }
}

/** 展示文件名而不是整条绝对路径，完整路径留在脚注里。 */
function baseName(p) {
  const parts = String(p).split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

/**
 * 引用完整性校验（强制环节）。
 * 每个 source_id 必须真实存在于 evidence 表，否则该条强制降级为 unverified。
 * 没有这一层，模型编造 source_id 会静默通过，整个可追溯承诺失效。
 * @param {string|string[]} localDates 允许的归属日：单日传字符串，多日区间（week）传该区间内的全部日期
 * @returns {{facts:any[], downgraded:number, missing:string[]}}
 */
export function validateReferences(db, facts, localDates) {
  const missing = [];
  let downgraded = 0;
  for (const f of facts) {
    const bad = [];
    for (const sid of f.source_ids) {
      const parsed = parseSourceId(sid);
      if (!parsed || !evidenceExists(db, parsed.sourceType, parsed.sourceRef, localDates)) bad.push(sid);
    }
    if (bad.length) {
      f.confidence = 'unverified';
      f.missing_source_ids = bad;
      missing.push(...bad);
      downgraded += 1;
    }
  }
  return { facts, downgraded, missing };
}
