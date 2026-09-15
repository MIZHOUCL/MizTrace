/**
 * SVN 采集（L0：只读元数据，不读 diff 正文）。
 *
 * 和 git 最大的区别，也是这个来源默认关闭的原因：**`svn log` 是向版本库服务器发起的查询**，
 * 不像 git log / git status 全在本地。所以 svn.enabled 默认 false；打开后也只读
 * revision / 作者 / 时间 / 提交说明 / 改动路径，不读 diff 正文。
 * `svn status` 与 `svn info` 是纯本地的（读 .svn/wc.db），不会联网。
 *
 * 一律用 execFileSync 数组参数调用系统 svn，不经 shell，避免注入。
 * --non-interactive 必须有：否则服务器要凭据时 svn 会停下来等输入，把整次采集卡死。
 *
 * 产出的 commits / dirty 与 git.js 保持同一形状，所以归因（day.js routeGitResult）、
 * 模块聚合（modules.js）、事实构建（facts.js）都不用为 SVN 写第二套；
 * 各自的 sourceType 由采集阶段写在自己的条目上，供证据层取用。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { inRange } from '../time.js';
import { shouldSkipDir } from './git.js';

/** 单个工作副本未提交改动的上限，与 git 一致。 */
export const MAX_DIRTY = 300;
/** 一次 svn log 最多取多少个 revision。 */
export const MAX_LOG = 500;
const LOG_TIMEOUT_MS = 20_000;
const STATUS_TIMEOUT_MS = 30_000;

/**
 * svn status 的 item → 与 git status 同风格的状态码，前端与脚注的文案保持一致。
 * normal / none / ignored / external 不在表里，取不到码就是「不算改动」；
 * 唯一的例外是 item="none" 但 props="modified"（只改了属性），下面单独兜住。
 */
const STATUS_CODES = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  replaced: 'R',
  conflicted: 'C',
  unversioned: '?',
  missing: '!',
  obstructed: '~',
  incomplete: '!',
};

/* ------------------------------------------------------------------ *
 * 一个够用的迷你 XML 读取器
 *
 * svn 的 --xml 输出只有元素、属性、文本三样东西。引第三方解析库会破坏「零依赖」，
 * 用正则逐字段硬切又会栽在 <msg> 里的换行、&lt; 转义和路径里的特殊字符上。
 * 所以这里写一个解析器，只服务这一件事，不做命名空间、不做 DTD。
 * ------------------------------------------------------------------ */

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

export function decodeXmlEntities(text) {
  return String(text).replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (whole, body) => {
    if (body[0] !== '#') return NAMED_ENTITIES[body] ?? whole;
    const hex = body[1] === 'x' || body[1] === 'X';
    const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
    return String.fromCodePoint(code);
  });
}

// 标签里的斜杠会被惰性量词优先让给「自闭合」那个可选捕获组，所以 <b/> 不会被当成开标签。
// 这一条是这个解析器最容易写错的地方：判错一次，后面的兄弟节点就全变成它的子节点了。
const TAG = /<(\/?)([A-Za-z_][\w.:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
const ATTR = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function parseAttributes(raw) {
  const attrs = {};
  ATTR.lastIndex = 0;
  let m;
  while ((m = ATTR.exec(raw))) attrs[m[1]] = decodeXmlEntities(m[2] ?? m[3] ?? '');
  return attrs;
}

/**
 * @param {string} source
 * @returns {{name:string, attrs:Record<string,string>, children:any[], text:string}}
 */
export function parseXml(source) {
  const root = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  const src = String(source ?? '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  TAG.lastIndex = 0;
  let cursor = 0;
  let m;
  while ((m = TAG.exec(src))) {
    const top = stack[stack.length - 1];
    if (m.index > cursor) top.text += decodeXmlEntities(src.slice(cursor, m.index));
    cursor = TAG.lastIndex;
    if (m[1] === '/') {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const node = { name: m[2], attrs: parseAttributes(m[3] ?? ''), children: [], text: '' };
    top.children.push(node);
    if (!m[4]) stack.push(node);
  }
  return root;
}

function childrenNamed(node, name) {
  return node?.children?.filter((c) => c.name === name) ?? [];
}

function childNamed(node, name) {
  return node?.children?.find((c) => c.name === name) ?? null;
}

function textOf(node) {
  return node ? String(node.text ?? '').trim() : '';
}

/** --xml 输出外面总包一层根元素（<log> / <status> / <info>），先剥掉它再找里面的东西。 */
function unwrap(xml, name) {
  const doc = parseXml(xml);
  return childNamed(doc, name) ?? doc;
}

/* ------------------------------------------------------------------ *
 * 调用 svn
 * ------------------------------------------------------------------ */

export function svnAvailable() {
  try {
    execFileSync('svn', ['--version', '--quiet'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

/** 默认执行器：execFileSync 数组参数，不经 shell。 */
function runSvn(cwd, args, timeoutMs = STATUS_TIMEOUT_MS) {
  return execFileSync('svn', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function svnSafe(run, cwd, args, fallback, warnings, timeoutMs) {
  try {
    return run(cwd, args, timeoutMs);
  } catch (err) {
    // 与 git 侧同样的态度：失败一律登记，由 CLI 打印出来，不静默吞掉。
    const detail = String(err?.stderr || err?.message || err).split('\n')[0];
    if (warnings) warnings.push(`svn ${args[0]} 在 ${cwd} 失败：${detail}`);
    return fallback;
  }
}

/** 工作副本的稳定短标识：两个不同仓库的 r814 是两个东西，证据 id 不能撞。 */
export function workingCopyId(wc) {
  const resolved = path.resolve(wc).replace(/\\/g, '/');
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 8);
}

/* ------------------------------------------------------------------ *
 * 在工作副本里找痕迹
 * ------------------------------------------------------------------ */

/**
 * 在给定根目录下查找 SVN 工作副本。
 * SVN 1.7 起只在工作副本根有 .svn，所以「目录里有 .svn」就等于「这是工作副本根」。
 * @param {string[]} roots
 * @param {number} maxDepth
 * @returns {string[]}
 */
export function findWorkingCopies(roots, maxDepth = 4) {
  const found = new Set();
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.name === '.svn')) found.add(dir);
    for (const e of entries) {
      if (!e.isDirectory() || shouldSkipDir(e.name)) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  for (const r of roots) walk(path.resolve(r), 0);
  return [...found].sort();
}

/** svn 的时间戳带 6 位小数（2026-09-15T02:11:33.123456Z），Date.parse 不保证认，统一裁到毫秒。 */
export function normalizeSvnDate(raw) {
  const m = String(raw ?? '')
    .trim()
    .match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z?$/);
  if (!m) return null;
  return `${m[1]}.${(m[2] ?? '').padEnd(3, '0').slice(0, 3)}Z`;
}

/**
 * `svn log -v` 的改动路径是仓库绝对路径（/trunk/src/a.js），要还原成工作副本内的相对路径，
 * 才能把一条提交归到正确的项目、并让模块里显示的文件名和 git 侧一样短。
 * @param {string} repoPath 形如 /trunk/src/a.js
 * @param {string|null} wcRepoPath 工作副本根在仓库里的位置，形如 trunk（来自 svn info 的 relative-url）
 */
export function repoPathToRelative(repoPath, wcRepoPath) {
  const p = String(repoPath ?? '').replace(/\/+$/, '');
  if (!p) return null;
  const base = String(wcRepoPath ?? '').replace(/^\/+|\/+$/g, '');
  if (!base) return p.replace(/^\/+/, '') || null;
  if (p === `/${base}`) return null; // 工作副本根自身，不是文件
  const prefix = `/${base}/`;
  return p.startsWith(prefix) ? p.slice(prefix.length) : null;
}

function matchesAuthor(author, filter) {
  const needle = String(filter ?? '').trim().toLowerCase();
  if (!needle) return true;
  return String(author ?? '').toLowerCase().includes(needle);
}

/**
 * 解析 `svn log --xml -v`。
 * @param {string} raw
 * @param {{wcRepoPath?:string|null, wcId?:string, authorFilter?:string|null}} [opts]
 */
export function parseLogXml(raw, opts = {}) {
  const out = [];
  for (const entry of childrenNamed(unwrap(raw, 'log'), 'logentry')) {
    const revision = entry.attrs.revision;
    if (!revision) continue;
    const author = textOf(childNamed(entry, 'author')) || null;
    if (!matchesAuthor(author, opts.authorFilter)) continue;
    const committedAt = normalizeSvnDate(textOf(childNamed(entry, 'date')));
    if (!committedAt) continue;
    const paths = childrenNamed(childNamed(entry, 'paths'), 'path');
    const files = [];
    for (const p of paths) {
      if (p.attrs.kind === 'dir') continue; // 目录本身不算改动，改的是里面的文件
      const rel = repoPathToRelative(textOf(p), opts.wcRepoPath);
      if (rel) files.push(rel);
    }
    out.push({
      // hash 是 git 侧的字段名，这里承载「工作副本 + revision」，因为两个仓库的 r814 是两个东西
      hash: `svn:r${revision}@${opts.wcId ?? ''}`,
      revision: Number.parseInt(revision, 10),
      sourceType: 'svn-commit',
      author,
      email: null,
      committedAt,
      message: textOf(childNamed(entry, 'msg')),
      // svn log 只给动作（M/A/D），不给行数；要行数得跑 svn diff 读正文，那违反本项目的规矩。
      // 所以这两个数恒为 0，facts.js 也据此不再渲染「+0 −0」。
      additions: 0,
      deletions: 0,
      files,
    });
  }
  return out;
}

/**
 * 解析 `svn status --xml`。只取状态与路径，不读内容；顺便 stat 出真实 mtime，
 * 否则未提交改动只能记成「现在」，时间线上会全堆在运行那一刻。
 * @param {string} raw
 * @param {string} [wc] 工作副本根，用来把 svn 给出的路径统一成相对路径
 */
export function parseStatusXml(raw, wc) {
  const out = [];
  const root = path.resolve(wc ?? '.');
  for (const target of childrenNamed(unwrap(raw, 'status'), 'target')) {
    for (const entry of childrenNamed(target, 'entry')) {
      const given = entry.attrs.path;
      if (!given) continue;
      const wcStatus = childNamed(entry, 'wc-status');
      const item = wcStatus?.attrs?.item ?? 'none';
      const props = wcStatus?.attrs?.props ?? 'none';
      const code = STATUS_CODES[item] ?? (item === 'none' && props === 'modified' ? 'M' : null);
      if (!code) continue;
      const absolute = path.isAbsolute(given) ? path.resolve(given) : path.resolve(root, given);
      let rel = path.relative(root, absolute) || given;
      if (path.sep === '\\') rel = rel.replace(/\\/g, '/');
      let mtime = null;
      let isDir = false;
      try {
        const st = fs.statSync(absolute);
        mtime = new Date(st.mtimeMs).toISOString();
        isDir = st.isDirectory();
      } catch {
        mtime = null; // 已删除的文件 stat 不到，属正常
      }
      // svn status 不展开未版本控制的目录，条目就是目录本身。
      // 把目录当成「改动的文件」记进去，模块里会冒出一个目录名的假文件，直接跳过。
      if (isDir && code === '?') continue;
      out.push({ status: code, path: rel, mtime, sourceType: 'svn-worktree' });
    }
  }
  return out;
}

/** `svn info --xml`：拿工作副本的仓库地址与它在仓库里的位置。纯本地操作，不联网。 */
export function parseInfoXml(raw) {
  const entry = childNamed(unwrap(raw, 'info'), 'entry');
  if (!entry) return { url: null, relativeUrl: null, repoRoot: null, revision: null };
  const relative = textOf(childNamed(entry, 'relative-url'));
  return {
    url: textOf(childNamed(entry, 'url')) || null,
    relativeUrl: relative ? relative.replace(/^\^\/*/, '') || null : null,
    repoRoot: textOf(childNamed(childNamed(entry, 'repository'), 'root')) || null,
    revision: entry.attrs.revision ?? null,
  };
}

/**
 * 这个工作副本是不是当天才 checkout 下来的。
 * 与 git 侧同理，但要小心 .svn 目录的 mtime 每次操作都会变（wc.db 在里面），所以只认 birthtime。
 * @returns {{at:string, remote:string|null}|null}
 */
function checkoutArrival(wc, range, repoUrl) {
  let ms = null;
  try {
    const b = fs.statSync(path.join(wc, '.svn')).birthtimeMs;
    ms = b > 0 ? b : null;
  } catch {
    ms = null;
  }
  if (ms == null) return null;
  const at = new Date(ms).toISOString();
  if (!inRange(at, range.startUtc, range.endUtc)) return null;
  return { at, remote: repoUrl ?? null };
}

function trimMs(iso) {
  return String(iso).replace(/\.\d+Z$/, 'Z');
}

/**
 * 采集一个工作副本在区间内的提交与本地改动。
 * @param {string} wc 工作副本根
 * @param {{startUtc:string,endUtc:string}} range
 * @param {{authorFilter?:string|null, remote?:boolean, limit?:number, maxDepth?:number, run?:Function}} [opts]
 *   remote=false 时只跑本地的 status / info，完全不碰版本库服务器。
 *   run 是给测试注入假 svn 执行器的口子，生产代码不要传。
 */
export function collectWorkingCopy(wc, range, opts = {}) {
  const warnings = [];
  const run = opts.run ?? runSvn;
  const id = workingCopyId(wc);
  const info = parseInfoXml(svnSafe(run, wc, ['info', '--xml', '--non-interactive'], '', warnings, STATUS_TIMEOUT_MS));
  const commits =
    opts.remote === false
      ? []
      : parseLogXml(
          svnSafe(run, wc, ['log', '--xml', '-v', '--non-interactive', '-r', `{${trimMs(range.startUtc)}}:{${trimMs(range.endUtc)}}`, '-l', String(opts.limit ?? MAX_LOG)], '', warnings, LOG_TIMEOUT_MS),
          { wcRepoPath: info.relativeUrl, wcId: id, authorFilter: opts.authorFilter },
        );
  let dirty = parseStatusXml(svnSafe(run, wc, ['status', '--xml', '--non-interactive'], '', warnings, STATUS_TIMEOUT_MS), wc);
  // 与 git 一致：未提交 ≠ 今天改的。一个放了三天没提交的改动不该天天出现在日志里。
  dirty = dirty.filter((d) => !d.mtime || inRange(d.mtime, range.startUtc, range.endUtc));
  if (dirty.length > MAX_DIRTY) {
    warnings.push(`${wc} 今天有 ${dirty.length} 个未提交改动，只保留前 ${MAX_DIRTY} 个`);
    dirty = dirty.slice(0, MAX_DIRTY);
  }
  return {
    repo: wc,
    vcs: 'svn',
    id,
    branch: info.relativeUrl,
    repoUrl: info.url,
    commits,
    dirty,
    warnings,
    arrival: checkoutArrival(wc, range, info.url),
  };
}
