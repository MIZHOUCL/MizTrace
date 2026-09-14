/**
 * Git 采集（L0：只读元数据，默认不读 diff 正文）。
 * 一律用 execFile 数组参数调用系统 git，不经 shell，避免注入。
 * 从会话 cwd 反查仓库的思路借鉴 temosy/devlog（MIT）。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { inRange } from '../time.js';

/** 单仓库未提交改动的上限，防止某个没 gitignore 的 build 目录炸掉输出。 */
export const MAX_DIRTY = 300;

const US = '\x1f'; // 字段分隔
const RS = '\x1e'; // 记录分隔

/** 遍历时跳过的目录：体积黑洞与无意义目录。 */
export const SKIP_DIRS = new Set([
  'node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build', 'out',
  'target', '.next', '.nuxt', '.cache', 'vendor', 'Pods', '.gradle', '.idea',
  'DerivedData', '.terraform', 'coverage', '.pnpm-store', '.turbo',
]);

export function gitAvailable() {
  try {
    execFileSync('git', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

function git(repo, args) {
  // core.quotePath=false：否则中文/非 ASCII 路径会被 git 转义成 \346\216\245 这种八进制串
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function gitSafe(repo, args, fallback = '', warnings) {
  try {
    return git(repo, args);
  } catch (err) {
    // 不要静默吞掉：`git status --no-color` 这种「未知选项」曾经让工作树证据整体消失，
    // 而调用方完全看不出来。失败一律登记，由 CLI 打印出来。
    const detail = String(err?.stderr || err?.message || err).split('\n')[0];
    if (warnings) warnings.push(`git ${args[0]} 在 ${repo} 失败：${detail}`);
    return fallback;
  }
}

/**
 * 在给定根目录下查找 git 仓库。
 * @param {string[]} roots
 * @param {number} maxDepth
 * @returns {string[]} 仓库根路径
 */
export function findRepos(roots, maxDepth = 4) {
  const found = new Set();
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.name === '.git')) {
      found.add(dir);
      // 父仓库里可能还放着多个独立项目；继续向下找，按仓库分别归组。
      // 父仓库不会把子仓库内部文件当成自己的普通改动，因此不会重复统计。
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  for (const r of roots) walk(path.resolve(r), 0);
  return [...found].sort();
}

/**
 * 父仓库的 status 可能把嵌套仓库整体报成 `?? child/`；这些状态由子仓库自己负责。
 * @param {string} repo
 * @param {{path:string}[]} dirty
 * @param {string[]} repos
 */
export function filterNestedRepoStatus(repo, dirty, repos) {
  const parent = path.resolve(repo);
  const nested = repos
    .map((r) => path.resolve(r))
    .filter((r) => r !== parent && r.startsWith(`${parent}${path.sep}`));
  if (!nested.length) return dirty;
  return dirty.filter((entry) => {
    // 只过滤父仓库把未跟踪的嵌套仓库报成 `?? child/` 的情况。
    // 已跟踪文件或 submodule 指针的变化仍属于父仓库证据，不能丢掉。
    if (entry.status !== '??') return true;
    const absolute = path.resolve(parent, entry.path);
    return !nested.some((r) => absolute === r || absolute.startsWith(`${r}${path.sep}`));
  });
}

/** 找出包含某路径的仓库根（用于按会话 cwd 反查）。 */
export function repoOf(somePath) {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: somePath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** 去掉远程地址里的凭据与 .git 后缀：https://user:token@github.com/a/b.git → github.com/a/b */
export function cleanRemote(url) {
  const raw = String(url ?? '').trim();
  if (!raw) return null;
  const ssh = raw.match(/^(?:ssh:\/\/)?(?:[\w.-]+@)?([\w.-]+)[:/](.+)$/);
  let out;
  try {
    const u = new URL(raw);
    out = `${u.host}${u.pathname}`;
  } catch {
    out = ssh ? `${ssh[1]}/${ssh[2]}` : raw.replace(/^[\w.-]+@/, '');
  }
  return out.replace(/\.git\/?$/, '').replace(/\/+$/, '') || null;
}

/**
 * 这个仓库是不是在区间内 clone / init 出来的。
 * 看 .git/description 的 mtime：clone 和 init 会写它，之后 git 再也不碰它，所以它就是仓库落地的时刻；
 * 拿不到再退回 .git 目录的创建时间。新 clone 的仓库没有当天的 commit、工作树也是干净的，
 * 没有这一步，「今天 clone 了一个项目」在日记里就是一片空白。
 * @returns {{at:string, remote:string|null}|null}
 */
export function repoArrival(repo, range) {
  let ms = null;
  try {
    ms = fs.statSync(path.join(repo, '.git', 'description')).mtimeMs;
  } catch {
    try {
      const b = fs.statSync(path.join(repo, '.git')).birthtimeMs;
      ms = b > 0 ? b : null;
    } catch {
      ms = null;
    }
  }
  if (ms == null) return null;
  const at = new Date(ms).toISOString();
  if (!inRange(at, range.startUtc, range.endUtc)) return null;
  const remote = cleanRemote(gitSafe(repo, ['config', '--get', 'remote.origin.url'], ''));
  return { at, remote };
}

/**
 * 采集一个仓库在区间内的 commit 与工作树状态，以及它是不是今天才 clone 下来的。
 * @param {string} repo
 * @param {{startUtc:string,endUtc:string}} range
 * @param {{authorFilter?:string|null}} [opts]
 */
export function collectRepo(repo, range, opts = {}) {
  const warnings = [];
  const branch = gitSafe(repo, ['rev-parse', '--abbrev-ref', 'HEAD'], '', warnings).trim() || null;
  const args = [
    'log',
    `--since=${range.startUtc}`,
    `--until=${range.endUtc}`,
    '--numstat',
    '--no-color',
    `--pretty=format:${RS}%H${US}%an${US}%ae${US}%aI${US}%s`,
  ];
  if (opts.authorFilter) args.push(`--author=${opts.authorFilter}`);
  const raw = gitSafe(repo, args, '', warnings);
  const commits = parseLog(raw);
  // 注意：git status 不接受 --no-color（--porcelain 本身就不带颜色），加了会整条命令失败。
  // --untracked-files=all：未跟踪目录展开成一个个文件，否则只会得到一个 `docs/`，
  // 它的 mtime 是目录本身的，跟里面文件何时被改无关，还会因为落在窗口外被判成 unverified。
  let dirty = parseStatus(gitSafe(repo, ['status', '--porcelain=v1', '--untracked-files=all'], '', warnings), repo);
  // 未提交 ≠ 今天改的：一个放了三天没提交的改动不该天天出现在日志里。
  // 拿不到 mtime 的（已删除）保留，归到「现在」。
  dirty = dirty.filter((d) => !d.mtime || inRange(d.mtime, range.startUtc, range.endUtc));
  if (dirty.length > MAX_DIRTY) {
    warnings.push(`${repo} 今天有 ${dirty.length} 个未提交改动，只保留前 ${MAX_DIRTY} 个`);
    dirty = dirty.slice(0, MAX_DIRTY);
  }
  const arrival = repoArrival(repo, range);
  return { repo, branch, commits, dirty, warnings, arrival };
}

/** 解析 `git log --numstat` 的输出。 */
export function parseLog(raw) {
  const out = [];
  for (const record of raw.split(RS)) {
    if (!record.trim()) continue;
    const lines = record.split('\n');
    const [hash, author, email, committedAt, ...rest] = lines[0].split(US);
    if (!hash) continue;
    const message = rest.join(US);
    let additions = 0;
    let deletions = 0;
    const files = [];
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      const [a, d, file] = line.split('\t');
      if (file === undefined) continue;
      additions += Number.parseInt(a, 10) || 0;
      deletions += Number.parseInt(d, 10) || 0;
      files.push(file);
    }
    out.push({ hash, author, email, committedAt, message, additions, deletions, files });
  }
  return out;
}

/**
 * 解析 `git status --porcelain=v1`。只取状态与路径，不读内容。
 * 顺便 stat 一下拿真实 mtime —— 否则未提交改动只能记成「现在」，
 * 时间线上会全部堆在运行那一刻，模块也就切不开。
 * @param {string} raw
 * @param {string} [repo] 仓库根，用于把相对路径还原成绝对路径去 stat
 */
export function parseStatus(raw, repo) {
  const out = [];
  for (const line of raw.split('\n')) {
    if (line.length < 4) continue;
    const status = line.slice(0, 2).trim();
    let file = line.slice(3);
    if (status === 'R' || status.startsWith('R')) {
      const parts = file.split(' -> ');
      file = parts[parts.length - 1];
    }
    const clean = file.replace(/^"|"$/g, '');
    let mtime = null;
    if (repo) {
      try {
        mtime = new Date(fs.statSync(path.join(repo, clean)).mtimeMs).toISOString();
      } catch {
        mtime = null; // 已删除的文件 stat 不到，属正常
      }
    }
    out.push({ status, path: clean, mtime });
  }
  return out;
}
