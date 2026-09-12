/**
 * 把一天的证据聚成「模块」—— 用户在前端勾选/戳破的单位，也是喂给模型写日记的单位。
 *
 * 为什么需要这一层：一天的原始证据可能有一两百条（实测 175 条），
 * 直接列出来没有重点，直接喂给模型也是垃圾进垃圾出。
 * 模块 = 同一个项目里、时间上连续的一段工作，带标题、时间段、证据量和权重。
 *
 * 证据种类（item.kind）：
 *   commit / worktree / file / action-file  —— 文件层面的痕迹（file 与 worktree 可能带 outline：文档大纲）
 *   prompt / reply                          —— 你问了什么、AI 工具最后答了什么（reply 通过 promptSourceId 挂在提问上）
 *   action-command / action-search          —— AI 工具执行的命令、联网搜索
 *   shell                                   —— 你自己在终端敲的命令（装了钩子才有，见 collect/shell.js）
 *   clone                                   —— 今天 clone / 新建的仓库
 *   note / image                            —— 你自己写的手记、配的图片（自成「我的手记」模块，权重最高）
 *   web                                     —— 浏览过的页面（自成「网页浏览」项目，按更短的间隔切段）
 */
import path from 'node:path';
import { sourceId } from './facts.js';
import { extensionOf } from './collect/files.js';
import { PROVIDER_NAMES } from './collect/sessions.js';

/** 同一项目内间隔超过这么久，算两段工作。 */
export const DEFAULT_GAP_MINUTES = 90;
/** 浏览是零碎的，切段间隔比项目短。 */
export const DEFAULT_WEB_GAP_MINUTES = 30;
/** 网页浏览不属于任何目录，用一个固定的伪项目承载；不进 projects 表，不参与路径归因。 */
export const WEB_PROJECT = { id: 'web', name: '网页浏览' };
/** 手记同样不属于任何目录。 */
export const NOTES_PROJECT = { id: 'notes', name: '我的手记' };

const CODE_EXT = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte', 'py', 'java', 'kt', 'go', 'rs', 'rb', 'php', 'cs', 'cpp', 'c', 'h', 'swift', 'scala', 'sh', 'ps1', 'lua', 'dart']);
const DOC_EXT = new Set(['md', 'markdown', 'txt', 'rst', 'adoc', 'docx', 'doc', 'pdf', 'pptx', 'ppt', 'rtf', 'odt', 'tex']);
const DATA_EXT = new Set(['sql', 'csv', 'tsv', 'xlsx', 'xls', 'ods', 'json', 'jsonl', 'yaml', 'yml', 'xml']);

const FILE_KINDS = new Set(['file', 'action-file', 'worktree']);
const TALK_KINDS = new Set(['prompt', 'action-command', 'action-search']);
const DEDUPE_KINDS = new Set(['prompt', 'action-command', 'action-search', 'reply', 'shell']);

/** 一段文字压成标题。中文没有空格，靠标点断句比分词靠得住。 */
export function toTitle(text, max = 32) {
  const t = String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s、，。：:,.\-—]+/, '')
    .trim();
  if (!t) return '';
  const cut = t.split(/[。！？\n?!]/)[0].trim() || t;
  return cut.length > max ? `${cut.slice(0, max)}…` : cut;
}

function categoryOf(items) {
  let code = 0;
  let doc = 0;
  let data = 0;
  // 以对话为主、几乎没碰文件的模块，按一两个文件的扩展名定类别没意义，单独归成「AI会话」
  const talk = items.filter((i) => TALK_KINDS.has(i.kind)).length;
  const shell = items.filter((i) => i.kind === 'shell').length;
  const fileish = items.filter((i) => FILE_KINDS.has(i.kind) || i.kind === 'commit').length;
  if (talk >= 3 && fileish <= 2) return 'AI会话';
  // 只在终端里敲命令、没提问也没怎么碰文件：归「终端」
  if (shell >= 3 && talk === 0 && fileish <= 2) return '终端';
  for (const it of items) {
    if (it.kind === 'commit' || it.kind === 'clone') code += 2;
    if (!FILE_KINDS.has(it.kind)) continue;
    const ext = extensionOf(path.basename(it.label || ''));
    if (CODE_EXT.has(ext)) code += 1;
    else if (DOC_EXT.has(ext)) doc += 1;
    else if (DATA_EXT.has(ext)) data += 1;
  }
  if (code === 0 && doc === 0 && data === 0) return talk ? 'AI会话' : '其他';
  if (code >= doc && code >= data) return '代码';
  if (doc >= data) return '文档';
  return '数据';
}

/**
 * 把一个项目里的所有证据摊平成带时间戳的条目，供后面按时间切块。
 * @returns {{ts:string, kind:string, label:string, sourceId:string}[]}
 */
export function timelineOf(project, input) {
  const items = [];
  for (const r of input.gitByProject.get(project.id) ?? []) {
    if (r.arrival) {
      const what = r.arrival.remote ? `clone 了 ${project.name}（${r.arrival.remote}）` : `新建仓库 ${project.name}`;
      items.push({ ts: r.arrival.at, kind: 'clone', label: what, sourceId: sourceId('clone', r.repo), remote: r.arrival.remote });
    }
    for (const c of r.commits) {
      items.push({ ts: c.committedAt, kind: 'commit', label: c.message, sourceId: sourceId('commit', c.hash), files: c.files.length });
    }
    for (const d of r.dirty) {
      // 有真实 mtime 就用它，拿不到（文件已删）才退回「现在」
      items.push({ ts: d.mtime ?? input.nowIso, kind: 'worktree', label: d.path, sourceId: sourceId('worktree', `${project.id}:${d.path}`), outline: d.outline?.items, outlineKind: d.outline?.kind });
    }
  }
  for (const s of input.sessionsByProject.get(project.id) ?? []) {
    for (const p of s.prompts) {
      items.push({ ts: p.ts, kind: 'prompt', label: p.text, sourceId: sourceId('session', `${s.sessionId}#${p.index}`), sessionTitle: s.title, provider: s.providerId });
    }
    for (const r of s.replies ?? []) {
      items.push({
        ts: r.ts,
        kind: 'reply',
        label: r.text,
        sourceId: sourceId('session-reply', `${s.sessionId}#${r.index}`),
        promptSourceId: sourceId('session', `${s.sessionId}#${r.promptIndex}`),
        provider: s.providerId,
      });
    }
    for (const a of s.actions) {
      items.push({
        ts: a.ts,
        kind: a.kind === 'file' ? 'action-file' : a.kind === 'search' ? 'action-search' : 'action-command',
        label: a.value,
        sourceId: sourceId('session-action', `${s.sessionId}#${a.index}:${a.kind}:${a.value}`),
        provider: s.providerId,
      });
    }
  }
  for (const h of input.filesByProject.get(project.id) ?? []) {
    items.push({ ts: h.mtime, kind: 'file', label: h.path, sourceId: sourceId('file', h.path), outline: h.outline?.items, outlineKind: h.outline?.kind, created: h.created === true });
  }
  for (const c of input.shellByProject?.get(project.id) ?? []) {
    items.push({ ts: c.ts, kind: 'shell', label: c.cmd, sourceId: sourceId('shell', c.id), cwd: c.cwd });
  }
  return items.filter((i) => i.ts).sort((a, b) => a.ts.localeCompare(b.ts));
}

/**
 * 按时间空隙切块。
 * 回复永远跟着它答的那条提问走：一次跑了两小时的 agent，最终回复比提问晚 120 分钟，
 * 中间又没别的证据，按空隙切会把回复切成孤零零的一块。
 */
export function splitByGap(items, gapMinutes = DEFAULT_GAP_MINUTES) {
  const blocks = [];
  const gapMs = gapMinutes * 60_000;
  for (const it of items) {
    const last = blocks[blocks.length - 1];
    if (last && (it.kind === 'reply' || Date.parse(it.ts) - Date.parse(last[last.length - 1].ts) <= gapMs)) last.push(it);
    else blocks.push([it]);
  }
  return blocks;
}

function statsOf(items) {
  const s = { commits: 0, clones: 0, prompts: 0, replies: 0, files: 0, created: 0, commands: 0, shell: 0, searches: 0, pages: 0, sites: 0, secs: 0, notes: 0, images: 0 };
  const files = new Set();
  const createdFiles = new Set();
  const pages = new Set();
  const sites = new Set();
  for (const it of items) {
    if (it.kind === 'commit') s.commits += 1;
    else if (it.kind === 'clone') s.clones += 1;
    else if (it.kind === 'prompt') s.prompts += 1;
    else if (it.kind === 'reply') s.replies += 1;
    else if (it.kind === 'action-command') s.commands += 1;
    else if (it.kind === 'shell') s.shell += 1;
    else if (it.kind === 'action-search') s.searches += 1;
    else if (it.kind === 'note') s.notes += 1;
    else if (it.kind === 'image') s.images += 1;
    else if (it.kind === 'web') {
      pages.add(it.url ?? it.sourceId);
      if (it.host) sites.add(it.host);
      s.secs += it.secs ?? 0;
    } else if (FILE_KINDS.has(it.kind)) {
      files.add(path.basename(it.label));
      if (it.created) createdFiles.add(path.basename(it.label));
    }
  }
  s.files = files.size;
  s.created = createdFiles.size;
  s.pages = pages.size;
  s.sites = sites.size;
  s.secs = Math.round(s.secs);
  return s;
}

/**
 * 这段工作里出现过的 AI 工具，按出现次数排。泡泡上标成「Codex · 项目名」，
 * 一眼看出这段是谁在干活 —— 之前只有项目名和提问原文，用户说「很不直观」。
 * @returns {{tools:string[], toolNames:string[]}}
 */
export function toolsOf(items) {
  const count = new Map();
  for (const it of items) if (it.provider) count.set(it.provider, (count.get(it.provider) ?? 0) + 1);
  const tools = [...count.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  return { tools, toolNames: tools.map((id) => PROVIDER_NAMES[id] ?? id) };
}

/** 起标题：commit message > clone > 会话标题 > 首条提问 > 文件概述 > 终端命令。 */
function titleOf(items, stats) {
  const commit = items.find((i) => i.kind === 'commit');
  if (commit) {
    const more = stats.commits > 1 ? `（等 ${stats.commits} 个提交）` : '';
    return `${toTitle(commit.label)}${more}`;
  }
  const clone = items.find((i) => i.kind === 'clone');
  if (clone) return toTitle(clone.label, 64);
  const withTitle = items.find((i) => i.kind === 'prompt' && i.sessionTitle);
  if (withTitle) return toTitle(withTitle.sessionTitle);
  const prompt = items.find((i) => i.kind === 'prompt');
  if (prompt) return toTitle(prompt.label);
  const fileItems = items.filter((i) => FILE_KINDS.has(i.kind));
  if (fileItems.length) return fileSummary(fileItems, stats);
  const search = items.find((i) => i.kind === 'action-search');
  if (search) return `搜索「${toTitle(search.label, 24)}」`;
  const shells = items.filter((i) => i.kind === 'shell');
  if (shells.length) return shellSummary(shells, stats);
  return '零散活动';
}

/** 纯终端命令的标题：按最常见的命令词概述 —— 「终端：npm、git 等 12 条命令」。 */
function shellSummary(shells, stats) {
  const words = new Map();
  for (const it of shells) {
    const w = String(it.label).trim().split(/\s+/)[0]?.replace(/^.*[\\/]/, '') || '';
    if (w) words.set(w, (words.get(w) ?? 0) + (it.repeats ?? 1));
  }
  const top = [...words.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k);
  if (stats.shell === 1) return `终端：${toTitle(shells[0].label, 36)}`;
  return `终端：${top.join('、')}${words.size > top.length ? ' 等' : ''} ${stats.shell} 条命令`;
}

/** 纯文件改动的标题：按最常见的目录和扩展名概述，比「改动 N 个文件（./）」有信息量。 */
function fileSummary(fileItems, stats) {
  // 有大纲的文档，标题直接用文档的第一条标题 —— 「改动 1 个文件：周报.docx」远不如「本周进展与风险」
  const withOutline = fileItems.filter((i) => i.outline?.length);
  if (fileItems.length <= 3 && withOutline.length) {
    const name = path.basename(withOutline[0].label).replace(/\.[^.]+$/, '');
    const head = withOutline[0].outlineKind === 'sheets' ? name : withOutline[0].outline[0];
    return fileItems.length === 1 ? toTitle(head, 30) : `${toTitle(head, 22)} 等 ${stats.files} 个文件`;
  }
  const dirs = new Map();
  const exts = new Map();
  for (const it of fileItems) {
    const dir = path.basename(path.dirname(it.label));
    if (dir && dir !== '.') dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
    const ext = extensionOf(path.basename(it.label));
    if (ext) exts.set(ext, (exts.get(ext) ?? 0) + 1);
  }
  const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
  const dirPart = top(dirs, 2).map((d) => `${d}/`).join('、');
  const extPart = top(exts, 3).map((e) => `.${e}`).join('、');
  if (dirPart) return `改动 ${stats.files} 个文件：${dirPart}${extPart ? `（${extPart}）` : ''}`;
  if (extPart) return `改动 ${stats.files} 个文件（${extPart}）`;
  return `改动 ${stats.files} 个文件`;
}

/**
 * 权重：有 commit 最实，其次有提问，纯文件改动最虚，浏览再虚一点。
 *
 * 文件数用平方根而不是线性 —— 一个目录里 60 个文件被碰过，说明的事情
 * 并不比 6 个多十倍（多半是某个程序在写状态）。实测那份 175 条的输出里，
 * QQ 的 62 个 .db-shm 如果按线性计权会直接压过当天真正的周报工作。
 * 回复不计分：它是提问的影子，不是新的工作。
 */
export function scoreOf(stats, durationMin) {
  const base = stats.commits * 6 + (stats.clones ?? 0) * 4 + stats.prompts * 3 + (stats.commands + (stats.searches ?? 0)) * 1.5 + (stats.shell ?? 0) * 1 + 3 * Math.sqrt(stats.files) + 2 * Math.sqrt(stats.pages ?? 0);
  const durationBoost = Math.min(1 + durationMin / 120, 2); // 持续越久权重越高，最多翻倍
  return Math.round(base * durationBoost * 10) / 10;
}

/** 改一份文档 / 表格 / 演示就是一段工作，哪怕一天只碰了这一个文件：周报、方案、台账都长这样。 */
const DOC_WORK_EXT = new Set([...DOC_EXT, 'xlsx', 'xls', 'ods', 'csv', 'pptx', 'ppt']);

/**
 * 低信号：没有提问也没有 commit，只有零星几个代码 / 配置文件 —— 这种不该占日记的篇幅。
 * 文档类文件不算低信号：用户实测「今天改了甚至新建了一个表格，项目检索却没体现」——
 * 就是因为一个 xlsx 落进了「零星改动」被默认排除。
 */
function isLowSignal(stats, items = []) {
  if (stats.commits || stats.clones || stats.prompts || stats.commands || stats.shell || stats.searches || stats.pages || stats.files > 2) return false;
  return !items.some((i) => FILE_KINDS.has(i.kind) && (DOC_WORK_EXT.has(extensionOf(path.basename(i.label || ''))) || i.outline?.length));
}

/** 解压 / 复制检测的窗口：一批文件的 mtime 落在这么短的时间内，说明不是人手改的。 */
export const BURST_WINDOW_MS = 5_000;
export const BURST_MIN_FILES = 8;

/**
 * 一堆文件在几秒内同时出现 = 解压、复制、git clone、npm install —— 不是「做了工作」。
 * 实测：下载 MizTrace 的 zip 解压后，39 个文件同一秒的 mtime 被记成了「改动 39 个文件」。
 * 判定：无提问无提交无命令，且 ≥80% 的文件落在同一个 5 秒窗口里。
 * @returns {boolean}
 */
export function isBurst(items, stats) {
  if (stats.prompts || stats.commits || stats.commands || stats.shell) return false;
  const times = items
    .filter((i) => i.kind === 'file' || i.kind === 'worktree')
    .map((i) => Date.parse(i.ts))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (times.length < BURST_MIN_FILES) return false;
  let best = 0;
  let lo = 0;
  for (let hi = 0; hi < times.length; hi += 1) {
    while (times[hi] - times[lo] > BURST_WINDOW_MS) lo += 1;
    best = Math.max(best, hi - lo + 1);
  }
  return best >= Math.ceil(times.length * 0.8);
}

/**
 * 跨运行稳定的模块键。id 里带序号，证据一变序号就变，用户昨天戳掉的模块今天又冒出来。
 * 用「项目 + 起始小时（UTC）」当键：同一段工作即使多了几条新证据，起始小时基本不动。
 */
export function moduleKey(projectId, startTs) {
  return `${projectId ?? 'misc'}@${String(startTs ?? '').slice(0, 13)}`;
}

/**
 * 同一模块内完全相同的提问 / 命令 / 回复只留一条。
 * 实测：Claude Code 每次「继续」会开新会话文件、Codex resume 会生成新的 rollout，
 * 首条消息一字不差地重复 4-5 次，日记里就成了同一句话刷屏。
 * 去重后把其余来源挂在 altSourceIds 上，脚注仍能指回每一次出现。
 * 回复挂在被合并掉的提问上时，改挂到留下的那条提问上。
 */
export function dedupeItems(items) {
  const seen = new Map();
  const promptAlias = new Map(); // 被合并的提问 sourceId → 留下的那条
  const out = [];
  for (const it of items) {
    if (!DEDUPE_KINDS.has(it.kind)) {
      out.push(it);
      continue;
    }
    const key = `${it.kind}|${String(it.label).replace(/\s+/g, ' ').trim()}`;
    const first = seen.get(key);
    if (first) {
      (first.altSourceIds ??= []).push(it.sourceId);
      first.repeats = (first.repeats ?? 1) + 1;
      if (it.kind === 'prompt') promptAlias.set(it.sourceId, first.sourceId);
    } else {
      const copy = { ...it };
      if (copy.kind === 'reply' && copy.promptSourceId && promptAlias.has(copy.promptSourceId)) copy.promptSourceId = promptAlias.get(copy.promptSourceId);
      seen.set(key, copy);
      out.push(copy);
    }
  }
  return out;
}

/** 给前端 / 模型用的精简条目：去掉内部字段，label 只留 basename（文件）或原文（提问、提交）。 */
function publicItems(items) {
  return items.map((i) => {
    const isFile = FILE_KINDS.has(i.kind);
    return {
      kind: i.kind,
      ts: i.ts,
      sourceId: i.sourceId,
      altSourceIds: i.altSourceIds,
      repeats: i.repeats,
      label: isFile ? path.basename(i.label) : i.label,
      path: isFile ? i.label : undefined,
      outline: isFile && i.outline?.length ? i.outline : undefined,
      outlineKind: isFile && i.outline?.length ? i.outlineKind : undefined,
      promptSourceId: i.kind === 'reply' ? i.promptSourceId : undefined,
      provider: i.provider ?? undefined,
      created: isFile && i.created ? true : undefined,
      cwd: i.kind === 'shell' ? i.cwd : undefined,
      remote: i.kind === 'clone' ? i.remote ?? undefined : undefined,
      mime: i.kind === 'image' ? i.mime : undefined,
      imageId: i.kind === 'image' ? i.imageId : undefined,
      forKey: i.kind === 'image' ? i.forKey ?? undefined : undefined,
      url: i.kind === 'web' ? i.url : undefined,
      host: i.kind === 'web' ? i.host : undefined,
      term: i.kind === 'web' ? i.term ?? undefined : undefined,
      secs: i.kind === 'web' ? i.secs : undefined,
      tsEnd: i.kind === 'web' ? i.tsEnd : undefined,
    };
  });
}

/** 浏览段的标题：搜索词最能说明在干什么，其次是站点。 */
export function webTitle(block, stats) {
  const hosts = new Map();
  for (const it of block) hosts.set(it.host, (hosts.get(it.host) ?? 0) + 1);
  const top = [...hosts.entries()].sort((a, b) => b[1] - a[1]).map(([h]) => h);
  const terms = block.filter((i) => i.term).map((i) => i.term);
  if (terms.length) {
    const more = terms.length > 1 ? `等 ${terms.length} 次` : '';
    return `搜索「${toTitle(terms[0], 18)}」${more}，浏览 ${stats.pages} 个页面`;
  }
  return `浏览 ${stats.pages} 个页面：${top.slice(0, 3).join('、')}`;
}

/** 一段里的逐次访问 → 每页一条（同一页在这一段里看了几次就记几次）。 */
function pagesInBlock(visits) {
  const byUrl = new Map();
  for (const v of visits) {
    const cur = byUrl.get(v.url);
    if (!cur) byUrl.set(v.url, { ts: v.ts, tsEnd: v.ts, kind: 'web', label: v.title, sourceId: sourceId('web', v.url), url: v.url, host: v.host, term: v.term ?? null, repeats: 1, secs: v.secs ?? 0 });
    else {
      cur.repeats += 1;
      cur.secs += v.secs ?? 0;
      if (v.ts > cur.tsEnd) cur.tsEnd = v.ts;
      if (v.title && v.title.length > cur.label.length) cur.label = v.title;
    }
  }
  return [...byUrl.values()];
}

/**
 * 浏览记录 → 模块。不属于任何目录，自成「网页浏览」项目，用更短的间隔切段；
 * 每段只有一两个页面的并成「零散浏览」并默认排除 —— 顺手打开的一个页面不值得进日记。
 * 先按逐次访问切段、再在段内合并同一页：同一个 OA 页面早上开一次、下午开一次，是两段工作，不能被拉成一段 7 小时的痕迹。
 * @param {{ts:string,url:string,host:string,title:string,term?:string|null,secs?:number}[]} visits 逐次访问，已归一化
 */
export function webModules(visits, opts = {}) {
  const gap = opts.gapMinutes ?? DEFAULT_WEB_GAP_MINUTES;
  const sorted = (visits ?? []).filter((v) => v.ts && v.url).map((v) => ({ ...v, kind: 'visit' })).sort((a, b) => a.ts.localeCompare(b.ts));
  const modules = [];
  const small = [];
  for (const rawBlock of splitByGap(sorted, gap)) {
    const block = pagesInBlock(rawBlock);
    const stats = statsOf(block);
    if (stats.pages < 3) {
      small.push(...block);
      continue;
    }
    const startTs = block[0].ts;
    const endTs = block.reduce((m, i) => (i.tsEnd && i.tsEnd > m ? i.tsEnd : m), block[block.length - 1].ts);
    const durationMin = Math.max(0, Math.round((Date.parse(endTs) - Date.parse(startTs)) / 60_000));
    modules.push({
      id: `mod:web:${modules.length}`,
      // 浏览段按 30 分钟切，同一小时里常有两段：键精确到分钟，否则两段共用一个键，补充说明和配图会挂错
      key: `${WEB_PROJECT.id}@${String(startTs).slice(0, 16)}`,
      title: webTitle(block, stats),
      category: '网页',
      projectId: WEB_PROJECT.id,
      projectName: WEB_PROJECT.name,
      startTs,
      endTs,
      durationMin,
      stats,
      sourceIds: [...new Set(block.map((i) => i.sourceId))],
      items: publicItems(block),
      score: scoreOf(stats, durationMin),
      selected: true,
      why: `连续 ${durationMin} 分钟的浏览，${stats.sites} 个站点${stats.secs >= 60 ? `，页面停留合计约 ${Math.round(stats.secs / 60)} 分钟` : ''}（间隔 > ${gap} 分钟即切段）`,
    });
  }
  if (small.length) {
    const stats = statsOf(small);
    modules.push({
      id: 'mod:web-misc',
      key: `web-misc@${String(opts.localDate ?? small[0].ts).slice(0, 10)}`,
      title: `零散浏览 ${stats.pages} 个页面`,
      category: '网页',
      projectId: WEB_PROJECT.id,
      projectName: WEB_PROJECT.name,
      startTs: small[0].ts,
      endTs: small[small.length - 1].ts,
      durationMin: 0,
      stats,
      sourceIds: [...new Set(small.map((i) => i.sourceId))],
      items: publicItems(small),
      score: 0,
      selected: false,
      why: '每段只顺手看了一两个页面，已并成一组并默认排除',
    });
  }
  return modules;
}

/**
 * 手记 → 一个模块。用户亲手写的是最可信、最该进日记的东西，权重压过一切；没写也没传图就没有这个模块。
 * 时间：文字用最后一次保存的时间，图片用上传时间；都没有就用当天 12:00（只影响时间板上的位置）。
 * @param {{text?:string, updatedAt?:string|null, images?:{id:string,name:string,mime:string,path:string,ts?:string}[]}} notes
 */
export function notesModule(notes, localDate) {
  const text = String(notes?.text ?? '').trim();
  // 给某个泡泡补的图（forKey）挂在那个泡泡上，不进手记模块
  const images = (Array.isArray(notes?.images) ? notes.images : []).filter((im) => !im.forKey);
  if (!text && !images.length) return null;
  const fallback = `${localDate}T12:00:00.000Z`;
  const items = [];
  if (text) items.push({ ts: notes.updatedAt ?? fallback, kind: 'note', label: text, sourceId: sourceId('note', localDate) });
  for (const im of images) items.push({ ts: im.ts ?? fallback, kind: 'image', label: im.name, sourceId: sourceId('image', im.id), mime: im.mime, imageId: im.id });
  items.sort((a, b) => a.ts.localeCompare(b.ts));
  const stats = statsOf(items);
  return {
    id: 'mod:notes',
    key: `notes@${localDate}`,
    title: text ? toTitle(text, 40) : `${images.length} 张图片`,
    category: '手记',
    projectId: NOTES_PROJECT.id,
    projectName: NOTES_PROJECT.name,
    startTs: items[0].ts,
    endTs: items[items.length - 1].ts,
    durationMin: 0,
    stats,
    sourceIds: items.map((i) => i.sourceId),
    items: publicItems(items),
    score: 100,
    selected: true,
    why: '你自己写的记录，模型会优先采信；不想写进日记就戳破它',
  };
}

/** 键撞车（同一项目同一小时两段）就按时间顺序加 #2、#3：第一段的键不变，用户之前写的补充说明还在。 */
export function dedupeKeys(modules) {
  const seen = new Map();
  for (const m of [...modules].sort((a, b) => String(a.startTs).localeCompare(String(b.startTs)))) {
    const n = (seen.get(m.key) ?? 0) + 1;
    seen.set(m.key, n);
    if (n > 1) m.key = `${m.key}#${n}`;
  }
  return modules;
}

/**
 * 用户给某个泡泡补的图片（notes.images 里带 forKey 的）挂到那个模块上：成为它的一条 image 证据，
 * 和补充说明一样是用户亲手给的、最高优先级。模块今天不在了（证据变了、键变了）的图就先不显示，删掉即可。
 */
export function attachHintImages(modules, notes, localDate) {
  const images = (Array.isArray(notes?.images) ? notes.images : []).filter((im) => im.forKey);
  if (!images.length) return;
  const byKey = new Map(modules.map((m) => [m.key, m]));
  const fallback = `${localDate ?? ''}T12:00:00.000Z`;
  for (const im of images) {
    const m = byKey.get(im.forKey);
    if (!m) continue;
    const item = { ts: im.ts ?? fallback, kind: 'image', label: im.name, sourceId: sourceId('image', im.id), mime: im.mime, imageId: im.id, forKey: im.forKey };
    m.items = [...m.items, ...publicItems([item])];
    m.sourceIds = [...new Set([...m.sourceIds, item.sourceId])];
    m.stats = { ...m.stats, images: (m.stats.images ?? 0) + 1 };
  }
}

/**
 * 聚成模块。
 * @param {{projects:any[], gitByProject:Map, sessionsByProject:Map, filesByProject:Map, shellByProject?:Map, nowIso:string, webVisits?:any[]}} input
 * @param {{gapMinutes?:number, webGapMinutes?:number, localDate?:string}} [opts]
 */
export function buildModules(input, opts = {}) {
  const gap = opts.gapMinutes ?? DEFAULT_GAP_MINUTES;
  const modules = [];
  const leftovers = [];
  const notes = opts.localDate ? notesModule(input.notes, opts.localDate) : null;
  if (notes) modules.push(notes);

  for (const project of input.projects) {
    const items = timelineOf(project, input);
    if (!items.length) continue;
    for (const rawBlock of splitByGap(items, gap)) {
      const block = dedupeItems(rawBlock);
      const stats = statsOf(block);
      const startTs = block[0].ts;
      const endTs = block[block.length - 1].ts;
      const durationMin = Math.max(0, Math.round((Date.parse(endTs) - Date.parse(startTs)) / 60_000));
      if (isLowSignal(stats, block)) {
        leftovers.push(...block);
        continue;
      }
      if (isBurst(block, stats)) {
        // 一批文件同时落地 = 下载 / 解压 / 复制来了一个项目。这不是「改了 39 个文件」，
        // 但「今天拿到了 MizTrace-main」值得在日记里占一句 —— 默认写进去，权重压低，模型只会一句带过。
        modules.push({
          id: `mod:${project.id}:${modules.length}`,
          key: moduleKey(project.id, startTs),
          title: `新增项目 ${project.name}（${stats.files} 个文件）`,
          category: '杂项',
          projectId: project.id,
          projectName: project.name,
          startTs,
          endTs,
          durationMin,
          stats,
          sourceIds: [...new Set(block.map((i) => i.sourceId))],
          items: publicItems(block),
          ...toolsOf(block),
          score: 1,
          selected: true,
          burst: true,
          why: `${stats.files} 个文件在 ${BURST_WINDOW_MS / 1000} 秒内同时出现，像下载 / 解压 / 复制来的一个项目，不像人手改动；日记里只会一句带过`,
        });
        continue;
      }
      modules.push({
        id: `mod:${project.id}:${modules.length}`,
        key: moduleKey(project.id, startTs),
        title: titleOf(block, stats),
        category: categoryOf(block),
        projectId: project.id,
        projectName: project.name,
        startTs,
        endTs,
        durationMin,
        stats,
        sourceIds: [...new Set(block.map((i) => i.sourceId))],
        items: publicItems(block),
        ...toolsOf(block),
        score: scoreOf(stats, durationMin),
        selected: true,
        why: `${project.name} 内一段连续 ${durationMin} 分钟的工作（间隔 > ${gap} 分钟即切块）`,
      });
    }
  }

  modules.push(...webModules(input.webVisits, { gapMinutes: opts.webGapMinutes, localDate: opts.localDate }));

  dedupeKeys(modules);
  attachHintImages(modules, input.notes, opts.localDate);
  modules.sort((a, b) => b.score - a.score);

  if (leftovers.length) {
    const stats = statsOf(leftovers);
    modules.push({
      id: 'mod:misc',
      key: `misc@${String(opts.localDate ?? leftovers[0].ts).slice(0, 10)}`,
      title: `零散文件改动 ${stats.files} 个`,
      category: '杂项',
      projectId: null,
      projectName: '杂项',
      startTs: leftovers[0].ts,
      endTs: leftovers[leftovers.length - 1].ts,
      durationMin: 0,
      stats,
      sourceIds: [...new Set(leftovers.map((i) => i.sourceId))],
      items: publicItems(leftovers),
      score: 0,
      // 默认不进日记：没有提问也没有提交的零星文件，写进日记只会稀释重点
      selected: false,
      why: '没有提问也没有提交、只有零星几个文件改动的项目，已合并到杂项并默认排除',
    });
  }

  return modules;
}
