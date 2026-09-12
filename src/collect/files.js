/**
 * 文件系统扫描（L0：只记路径、时间、大小，绝不读正文）。
 *
 * 为什么加回来：ADR-001 原本砍掉了这一层，理由是「git 已经覆盖文件变更」。
 * 实际使用证明这个判断是错的 —— 大量工作发生在没进 git 的目录里，
 * 只看 git + AI 会话会漏掉用户当天的大部分动作。详见 ADR-019。
 *
 * 与 git 的分工：**落在 git 仓库内的文件一律跳过**，交给 git 采集器处理，
 * 避免同一份改动被记两遍。仓库外的文件才由这里负责。
 */
import fs from 'node:fs';
import path from 'node:path';
import { SKIP_DIRS } from './git.js';

/** 目录黑洞：体积大、变动频繁、对日志没有意义。 */
export const EXTRA_SKIP_DIRS = new Set([
  'Library', 'AppData', 'Applications', 'System', 'Windows', 'Program Files',
  'Program Files (x86)', 'ProgramData', '$RECYCLE.BIN', 'System Volume Information',
  'Trash', '.Trash', 'Downloads.localized', 'Music', 'Movies', 'Pictures', 'Photos',
  'site-packages', 'Cellar', 'pkg', 'obj', 'tmp', 'temp', 'logs',
  // 应用运行时数据目录：实测在 Windows 上污染最严重的几个来源
  'WXWork', 'Tencent Files', 'nt_qq', 'nt_db', 'nt_temp', 'nt_msg',
  'postgreSQL', 'pgdata', 'pg_wal', 'pg_stat', 'pg_notify',
  'Avator', 'BrowserCache', 'Code Cache', 'GPUCache', 'blob_storage',
  'CrashDumps', 'Crashpad', 'IndexedDB', 'Local Storage', 'Service Worker',
]);

/**
 * 只把「像工作产物」的文件计入日志。
 *
 * 为什么用扩展名白名单而不是继续加黑名单：实测在 Windows 上一次扫描吐出了
 * 175 条事实，其中绝大多数是 `.db-shm` / `NTUSER.DAT{...}.regtrans-ms` /
 * `pg_internal.init` 这类应用运行时状态。黑名单永远追不上，白名单一次到位。
 * 日志工具应该宁缺毋滥 —— 漏记一个冷门格式，比每天读 160 行垃圾好。
 * 想放宽用 config.json 的 fileScan.extraExtensions，或 fileScan.mode: "all"。
 */
export const WORK_EXTENSIONS = new Set([
  // 代码
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte', 'py', 'ipynb', 'java', 'kt', 'kts',
  'go', 'rs', 'rb', 'php', 'cs', 'cpp', 'cc', 'c', 'h', 'hpp', 'swift', 'm', 'mm', 'scala',
  'sh', 'bash', 'zsh', 'ps1', 'bat', 'lua', 'pl', 'r', 'dart', 'ex', 'exs', 'clj', 'hs',
  // 标记 / 样式 / 模板
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'ejs', 'hbs', 'pug', 'astro',
  // 文档
  'md', 'markdown', 'txt', 'rst', 'adoc', 'org', 'tex', 'docx', 'doc', 'pdf', 'rtf', 'odt',
  'pptx', 'ppt', 'key', 'numbers', 'pages',
  // 数据 / 配置
  'sql', 'csv', 'tsv', 'xlsx', 'xls', 'ods', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini',
  'conf', 'cfg', 'properties', 'env-example', 'xml', 'proto', 'graphql', 'gql',
  // 设计 / 图
  'drawio', 'excalidraw', 'fig', 'sketch', 'psd', 'ai', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp',
]);

/** 没有扩展名但确实是工作产物的文件名。 */
export const WORK_FILENAMES = new Set([
  'Dockerfile', 'Makefile', 'Justfile', 'Rakefile', 'Gemfile', 'Procfile', 'Brewfile',
  'README', 'LICENSE', 'CHANGELOG', 'CONTRIBUTING', 'AGENTS', 'CLAUDE',
  'requirements.txt', 'go.mod', 'go.sum', 'Cargo.toml', 'pom.xml', 'build.gradle',
]);

/** 即使扩展名在白名单里，这些名字也是噪音（应用状态、临时文件、锁）。 */
const NOISE_PATTERNS = [
  /^~\$/, // Office 打开文档时的锁文件：~$周报.xlsx
  /^\.~lock\./, // LibreOffice 的锁文件
  /\.db(-shm|-wal|-journal)?$/i,
  /^NTUSER\.DAT/i,
  /\.(regtrans-ms|blf|pma|etl|evtx|dmp|crdownload|part|partial|swp|swo|orig|rej)$/i,
  /^(Thumbs\.db|desktop\.ini|\.DS_Store|lockfile|\.lock)$/i,
  /\.(lock|pid|tmp|temp|bak|old|cache)$/i,
  /^(pg_control|pg_internal\.init|postmaster\.(pid|opts)|current_logfiles)$/i,
  /^(Config\.cfg|Local State|Last Browser|Variations|Preferences)$/i,
  /\.(lnk|url|webloc|exe|msi|dmg|pkg|deb|rpm|appimage|zip|7z|rar|tar|gz|xz|iso)$/i,
  /^BrowserMetrics/i,
  /\.log(\.\d+)?$/i,
];

/** 扩展名（小写，不含点）。没有扩展名返回空串。 */
export function extensionOf(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

/**
 * 这个文件是否像「工作产物」。
 * @param {string} name 文件名
 * @param {{mode?:string, extraExtensions?:string[]}} [opts]
 */
export function isWorkLike(name, opts = {}) {
  if (NOISE_PATTERNS.some((re) => re.test(name))) return false;
  if (opts.mode === 'all') return true;
  const ext = extensionOf(name);
  if (ext && WORK_EXTENSIONS.has(ext)) return true;
  if (ext && (opts.extraExtensions ?? []).includes(ext)) return true;
  if (!ext && WORK_FILENAMES.has(name)) return true;
  // requirements.txt 之类带扩展名的已知文件名
  return WORK_FILENAMES.has(name);
}

/**
 * 疑似敏感文件：默认连路径都不记。
 * 故意用精确一点的规则而不是 `secret*` / `token*` 这类前缀通配 ——
 * 后者会把 tokenizer.ts、secrets.example.json 这种正常文件一起误伤。
 */
const SENSITIVE_PATTERNS = [
  /^\.env(\..+)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks|asc|gpg)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^credentials?\.(json|ya?ml|ini|toml)$/i,
  /^\.?(npmrc|netrc|pgpass|htpasswd)$/i,
  /^(service-account|gcp-key|aws-credentials).*\.json$/i,
  /\.kdbx$/i,
];

export function isSensitiveName(name) {
  return SENSITIVE_PATTERNS.some((re) => re.test(name));
}

/** 是否落在任意一个 git 仓库内。 */
export function insideRepo(filePath, repos) {
  const target = path.resolve(filePath);
  return repos.some((r) => {
    const root = path.resolve(r);
    return target === root || target.startsWith(`${root}${path.sep}`);
  });
}

/**
 * 扫描 roots 下在时间窗口内被改动过、或新出现的文件。
 * 返回的 mtime 是「落在窗口内的那个时间」：正常改动是修改时间；
 * 修改时间在窗口外、创建时间在窗口内的（下载 / 解压 / 复制来的）用创建时间，并标 created: true。
 * @param {string[]} roots
 * @param {{startUtc:string,endUtc:string}} range
 * @param {{repos?:string[], maxDepth?:number, maxFiles?:number, extraExcludes?:string[], mode?:string, extraExtensions?:string[], excludePaths?:string[]}} [opts]
 */
export function scanFiles(roots, range, opts = {}) {
  const { repos = [], maxDepth = 6, maxFiles = 5000, extraExcludes = [], mode = 'worklike', extraExtensions = [], excludePaths = [] } = opts;
  // 绝对路径级排除：日志输出目录、miztrace 自己的数据目录 —— 否则日志会把自己也记进去
  const excludedRoots = excludePaths.filter(Boolean).map((p) => path.resolve(p));
  const underExcluded = (p) => excludedRoots.some((r) => p === r || p.startsWith(`${r}${path.sep}`));
  const start = Date.parse(range.startUtc);
  const end = Date.parse(range.endUtc);
  const extra = new Set(extraExcludes);
  const hits = [];
  const stats = { scanned: 0, dirs: 0, skippedInRepo: 0, skippedSensitive: 0, skippedNoise: 0, truncated: false };

  const skipDir = (name) => SKIP_DIRS.has(name) || EXTRA_SKIP_DIRS.has(name) || extra.has(name) || name.startsWith('.');

  const walk = (dir, depth) => {
    if (stats.truncated || depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 没权限或已删除，跳过而不是中断
    }
    stats.dirs += 1;
    for (const e of entries) {
      if (stats.truncated) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (skipDir(e.name) || underExcluded(full)) continue;
        walk(full, depth + 1);
        continue;
      }
      if (!e.isFile() || e.name.startsWith('.')) continue;
      stats.scanned += 1;
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      // 半开区间，与 time.js 一致。mtime 不在窗口内时再看它是不是「今天才出现在这里」：
      // 解压 / 下载 / 复制来的文件带着原来的 mtime（GitHub 的 zip 里是提交时间），
      // 只看 mtime 会把「今天下载了一个新项目」整个漏掉。
      // Windows / Linux 看创建时间；macOS 把 mtime 往回拨时会连创建时间一起拨回去（实测），
      // 所以再退一步看 ctime —— 它记的是 inode 上次变动（解压、移动进来、改权限），程序改不了它。
      let m = st.mtimeMs;
      let created = false;
      if (m < start || m >= end) {
        const b = st.birthtimeMs;
        const c = st.ctimeMs;
        if (b > 0 && b >= start && b < end) m = b;
        else if (c > 0 && c >= start && c < end) m = c;
        else continue;
        created = true;
      }
      if (insideRepo(full, repos)) {
        stats.skippedInRepo += 1;
        continue;
      }
      if (isSensitiveName(e.name)) {
        stats.skippedSensitive += 1;
        continue;
      }
      if (!isWorkLike(e.name, { mode, extraExtensions })) {
        stats.skippedNoise += 1;
        continue;
      }
      hits.push({ path: full, mtime: new Date(m).toISOString(), size: st.size, ...(created ? { created: true } : {}) });
      if (hits.length >= maxFiles) stats.truncated = true;
    }
  };

  for (const r of roots) walk(path.resolve(r), 0);
  hits.sort((a, b) => a.mtime.localeCompare(b.mtime));
  return { hits, stats };
}

/**
 * 给一个文件找它该归到哪个「项目」：root 下的第一层目录。
 * 例如 root=D:\code、file=D:\code\foo\src\a.ts => D:\code\foo
 */
export function projectDirOf(filePath, roots) {
  const target = path.resolve(filePath);
  let best = null;
  for (const r of roots) {
    const root = path.resolve(r);
    if (target === root || target.startsWith(`${root}${path.sep}`)) {
      if (!best || root.length > best.length) best = root;
    }
  }
  if (!best) return path.dirname(target);
  const rel = path.relative(best, target);
  const first = rel.split(path.sep)[0];
  // 文件直接躺在 root 里，就把 root 本身当项目
  return rel.includes(path.sep) ? path.join(best, first) : best;
}
