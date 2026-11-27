/**
 * 浏览器历史采集（ADR-022）。默认关闭，网页引导里检测到浏览器时可勾选打开。
 *
 * 读取方式：浏览器的历史库都是 SQLite，运行中被独占锁着，所以先把文件复制到临时目录再用 node:sqlite 读，读完即删。
 * 记什么：页面标题、去掉参数的地址（origin + path）、首次/末次访问时间、次数、搜索词。不读页面内容。
 * 不记什么：iframe 里的自动加载、浏览器内部页（chrome:// edge:// about:）、登录 / 授权域名、用户排除的域名。
 *
 * 时间戳：Chromium 是 1601-01-01 起的微秒，超出 JS 安全整数，换算在 SQL 里做（除以 1000 再减 11644473600000）；
 * Firefox 是 Unix 微秒；Safari 是 2001-01-01 起的秒。
 *
 * 这个模块**不发任何网络请求**，只读本地文件。CI 的网络边界 grep 同样管着它。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const CHROME_EPOCH_MS = 11_644_473_600_000n;
const SAFARI_EPOCH_S = 978_307_200;

/** 各浏览器的用户数据目录（相对 home 或环境变量）。 */
export const BROWSERS = [
  { id: 'chrome', name: 'Chrome', kind: 'chromium', darwin: 'Library/Application Support/Google/Chrome', win32: '$LOCALAPPDATA/Google/Chrome/User Data', linux: '.config/google-chrome' },
  { id: 'edge', name: 'Edge', kind: 'chromium', darwin: 'Library/Application Support/Microsoft Edge', win32: '$LOCALAPPDATA/Microsoft/Edge/User Data', linux: '.config/microsoft-edge' },
  { id: 'brave', name: 'Brave', kind: 'chromium', darwin: 'Library/Application Support/BraveSoftware/Brave-Browser', win32: '$LOCALAPPDATA/BraveSoftware/Brave-Browser/User Data', linux: '.config/BraveSoftware/Brave-Browser' },
  { id: 'chromium', name: 'Chromium', kind: 'chromium', darwin: 'Library/Application Support/Chromium', win32: '$LOCALAPPDATA/Chromium/User Data', linux: '.config/chromium' },
  { id: 'arc', name: 'Arc', kind: 'chromium', darwin: 'Library/Application Support/Arc/User Data', win32: '$LOCALAPPDATA/Packages/TheBrowserCompany.Arc_ttt1ap7aakyb4/LocalCache/Local/Arc/User Data' },
  { id: 'vivaldi', name: 'Vivaldi', kind: 'chromium', darwin: 'Library/Application Support/Vivaldi', win32: '$LOCALAPPDATA/Vivaldi/User Data', linux: '.config/vivaldi' },
  { id: 'firefox', name: 'Firefox', kind: 'firefox', darwin: 'Library/Application Support/Firefox/Profiles', win32: '$APPDATA/Mozilla/Firefox/Profiles', linux: '.mozilla/firefox' },
  { id: 'safari', name: 'Safari', kind: 'safari', darwin: 'Library/Safari/History.db' },
];

/** 登录 / 授权类域名：没有工作信息，也最容易带出账号，默认不记。 */
const NOISE_HOST = /^(accounts?|login|logon|auth|sso|oauth2?|signin|sign-in|id|idp|passport)\./i;
const NOISE_EXACT = new Set(['accounts.google.com', 'login.microsoftonline.com', 'login.live.com', 'appleid.apple.com', 'passport.baidu.com', 'open.weixin.qq.com']);

/** 常见搜索引擎的查询参数：搜索词是最有信息量的浏览证据。 */
const SEARCH_ENGINES = [
  { host: /(^|\.)google\.[a-z.]+$/i, param: 'q', path: /^\/search/ },
  { host: /(^|\.)bing\.com$/i, param: 'q', path: /^\/search/ },
  { host: /(^|\.)baidu\.com$/i, param: 'wd', path: /^\/s$/ },
  { host: /(^|\.)duckduckgo\.com$/i, param: 'q', path: /^\/$/ },
  { host: /(^|\.)sogou\.com$/i, param: 'query', path: /^\/web/ },
  { host: /(^|\.)so\.com$/i, param: 'q', path: /^\/s$/ },
  { host: /(^|\.)github\.com$/i, param: 'q', path: /^\/search/ },
  { host: /(^|\.)zhihu\.com$/i, param: 'q', path: /^\/search/ },
];

function expandDir(rel, home, env) {
  if (!rel) return null;
  const m = rel.match(/^\$(\w+)(.*)$/);
  if (m) {
    const base = env[m[1]];
    return base ? path.join(base, m[2]) : null;
  }
  return path.join(home, rel);
}

/** Chromium 系：用户数据目录下每个含 History 的 profile 目录。 */
function chromiumProfiles(userData) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(userData, { withFileTypes: true });
  } catch {
    return out;
  }
  let names = {};
  try {
    const state = JSON.parse(fs.readFileSync(path.join(userData, 'Local State'), 'utf8'));
    names = Object.fromEntries(Object.entries(state?.profile?.info_cache ?? {}).map(([dir, info]) => [dir, info?.name]));
  } catch {
    /* 没有 Local State 就用目录名 */
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === 'System Profile' || e.name === 'Guest Profile') continue;
    const file = path.join(userData, e.name, 'History');
    if (fs.existsSync(file)) out.push({ profile: names[e.name] || e.name, file });
  }
  return out;
}

function firefoxProfiles(profilesDir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(profilesDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const file = path.join(profilesDir, e.name, 'places.sqlite');
    if (fs.existsSync(file)) out.push({ profile: e.name.replace(/^[a-z0-9]{8}\./, ''), file });
  }
  return out;
}

/** 能不能真的读到（macOS 上 Safari 与部分目录受 TCC 保护，stat 得到但 open 会 EPERM）。 */
function probeReadable(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, Buffer.alloc(16), 0, 16, 0);
    } finally {
      fs.closeSync(fd);
    }
    return { readable: true };
  } catch (err) {
    const denied = err?.code === 'EPERM' || err?.code === 'EACCES';
    return { readable: false, error: denied ? '没有读取权限：macOS 上请在「系统设置 → 隐私与安全性 → 完全磁盘访问权限」里允许你运行 miztrace 的终端或 Node' : err?.message ?? String(err) };
  }
}

/**
 * 检测本机装了哪些浏览器、各有哪些 profile、能不能读。
 * @param {{home?:string, platform?:string, env?:Record<string,string>}} [opts] 测试时注入
 * @returns {{id:string,name:string,kind:string,profiles:{profile:string,file:string,readable:boolean,error?:string}[]}[]}
 */
export function detectBrowsers(opts = {}) {
  const home = opts.home ?? os.homedir();
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const out = [];
  for (const b of BROWSERS) {
    const base = expandDir(b[platform], home, env);
    if (!base || !fs.existsSync(base)) continue;
    let profiles = [];
    if (b.kind === 'chromium') profiles = chromiumProfiles(base);
    else if (b.kind === 'firefox') profiles = firefoxProfiles(base);
    else if (b.kind === 'safari') profiles = [{ profile: 'Default', file: base }];
    if (!profiles.length) continue;
    out.push({ id: b.id, name: b.name, kind: b.kind, profiles: profiles.map((p) => ({ ...p, ...probeReadable(p.file) })) });
  }
  return out;
}

function copyToTemp(file, extraSuffixes = []) {
  const stamp = crypto.randomBytes(6).toString('hex');
  const tmp = path.join(os.tmpdir(), `miztrace-${stamp}-${path.basename(file)}`);
  fs.copyFileSync(file, tmp);
  const copies = [tmp];
  for (const suf of extraSuffixes) {
    if (fs.existsSync(file + suf)) {
      fs.copyFileSync(file + suf, tmp + suf);
      copies.push(tmp + suf);
    }
  }
  return { tmp, copies };
}

function removeAll(files) {
  for (const f of files) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      /* 临时文件删不掉也不影响 */
    }
  }
}

/** 读一个历史库文件里落在窗口内的访问记录（原始行，未归一化）。导出以便单测。 */
export function readHistoryFile(file, kind, range) {
  const startMs = Date.parse(range.startUtc);
  const endMs = Date.parse(range.endUtc);
  const { tmp, copies } = copyToTemp(file, kind === 'firefox' ? ['-wal'] : []);
  let db;
  try {
    db = new DatabaseSync(tmp);
    if (kind === 'chromium') {
      const lo = (BigInt(startMs) + CHROME_EPOCH_MS) * 1000n;
      const hi = (BigInt(endMs) + CHROME_EPOCH_MS) * 1000n;
      const rows = db
        .prepare(
          `SELECT u.id AS url_id, u.url AS url, u.title AS title, u.hidden AS hidden,
                  (v.visit_time / 1000 - 11644473600000) AS ms, (v.transition & 255) AS core,
                  (v.visit_duration / 1000000) AS secs
           FROM visits v JOIN urls u ON u.id = v.url
           WHERE v.visit_time >= ? AND v.visit_time < ? ORDER BY v.visit_time`,
        )
        .all(lo, hi);
      let terms = new Map();
      try {
        terms = new Map(db.prepare('SELECT url_id, term FROM keyword_search_terms').all().map((r) => [r.url_id, r.term]));
      } catch {
        /* 旧版没有这张表 */
      }
      // core: 3 = 子框架自动加载（广告 / iframe），4 = 手动子框架；8 = 刷新
      return rows
        .filter((r) => !r.hidden && r.core !== 3 && r.core !== 4 && r.core !== 8)
        .map((r) => ({ url: r.url, title: r.title, ms: Number(r.ms), secs: Number(r.secs) || 0, term: terms.get(r.url_id) ?? null }));
    }
    if (kind === 'firefox') {
      const rows = db
        .prepare(
          `SELECT p.url AS url, p.title AS title, (v.visit_date / 1000) AS ms, v.visit_type AS core
           FROM moz_historyvisits v JOIN moz_places p ON p.id = v.place_id
           WHERE v.visit_date >= ? AND v.visit_date < ? ORDER BY v.visit_date`,
        )
        .all(startMs * 1000, endMs * 1000);
      // visit_type: 4 embed、5/6 重定向、8 框架内链接、9 刷新
      return rows.filter((r) => ![4, 5, 6, 8, 9].includes(Number(r.core))).map((r) => ({ url: r.url, title: r.title, ms: Number(r.ms), secs: 0, term: null }));
    }
    if (kind === 'safari') {
      const rows = db
        .prepare(
          `SELECT i.url AS url, v.title AS title, ((v.visit_time + ${SAFARI_EPOCH_S}) * 1000) AS ms
           FROM history_visits v JOIN history_items i ON i.id = v.history_item
           WHERE v.visit_time >= ? AND v.visit_time < ? ORDER BY v.visit_time`,
        )
        .all(startMs / 1000 - SAFARI_EPOCH_S, endMs / 1000 - SAFARI_EPOCH_S);
      return rows.map((r) => ({ url: r.url, title: r.title, ms: Math.round(Number(r.ms)), secs: 0, term: null }));
    }
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      /* 忽略 */
    }
    removeAll(copies);
  }
}

/** 搜索引擎结果页 → 搜索词。 */
export function searchTermOf(u) {
  for (const e of SEARCH_ENGINES) {
    if (e.host.test(u.hostname) && e.path.test(u.pathname)) {
      const q = u.searchParams.get(e.param);
      if (q && q.trim()) return q.trim();
    }
  }
  return null;
}

/**
 * 一条原始访问 → 归一化页面（去参数、判噪音、取搜索词）。返回 null 表示丢弃。
 * @param {{url:string,title?:string|null,ms:number,secs?:number,term?:string|null}} raw
 * @param {{excludeDomains?:string[]}} [opts]
 */
export function normalizeVisit(raw, opts = {}) {
  if (!raw?.url || !Number.isFinite(raw.ms)) return null;
  let u;
  try {
    u = new URL(raw.url);
  } catch {
    return null;
  }
  const isFile = u.protocol === 'file:';
  if (!isFile && u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = isFile ? '本地文件' : u.hostname.replace(/^www\./, '').toLowerCase();
  if (!isFile && (NOISE_EXACT.has(host) || NOISE_HOST.test(host))) return null;
  for (const d of opts.excludeDomains ?? []) {
    const dd = String(d).trim().toLowerCase();
    if (dd && (host === dd || host.endsWith(`.${dd}`) || host.includes(dd))) return null;
  }
  const term = raw.term?.trim() || (isFile ? null : searchTermOf(u));
  let url;
  let title = String(raw.title ?? '').replace(/\s+/g, ' ').trim();
  if (isFile) {
    let p = u.pathname;
    try {
      p = decodeURIComponent(p);
    } catch {
      /* 保留原样 */
    }
    if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1); // file:///D:/x → D:/x
    url = p;
    if (!title) title = path.basename(p);
  } else if (term) {
    // 搜索页：地址只保留搜索词这一个参数，不同的搜索才不会被合并成同一页
    url = `${u.origin}${u.pathname}?q=${encodeURIComponent(term)}`;
    title = `搜索「${term}」`;
  } else {
    url = `${u.origin}${u.pathname}`;
  }
  if (!title) title = isFile ? url : `${host}${u.pathname === '/' ? '' : u.pathname}`;
  if (title.length > 120) title = `${title.slice(0, 120)}…`;
  // MizTrace 自己的页面不记（否则日志会把自己也记进去）
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(host) && /^(MizTrace|DayTrace)\b/.test(title)) return null;
  return { ts: new Date(raw.ms).toISOString(), url, host, title, term, secs: Math.max(0, Number(raw.secs) || 0) };
}

/**
 * 同一页面一天里的多次访问合并成一条：首次 / 末次时间、次数、停留秒数。
 * @returns {{url:string,host:string,title:string,term:string|null,firstTs:string,lastTs:string,visits:number,secs:number,browser:string,profile:string}[]}
 */
export function groupPages(visits) {
  const byUrl = new Map();
  for (const v of visits) {
    const cur = byUrl.get(v.url);
    if (!cur) byUrl.set(v.url, { url: v.url, host: v.host, title: v.title, term: v.term, firstTs: v.ts, lastTs: v.ts, visits: 1, secs: v.secs, browser: v.browser, profile: v.profile });
    else {
      cur.visits += 1;
      cur.secs += v.secs;
      if (v.ts < cur.firstTs) cur.firstTs = v.ts;
      if (v.ts > cur.lastTs) cur.lastTs = v.ts;
      if (v.title && v.title.length > cur.title.length) cur.title = v.title;
    }
  }
  return [...byUrl.values()].sort((a, b) => a.firstTs.localeCompare(b.firstTs));
}

/**
 * 采集窗口内的浏览记录。
 * @param {{startUtc:string,endUtc:string}} range
 * @param {{browsers?:ReturnType<typeof detectBrowsers>, excludeDomains?:string[], only?:string[], maxPages?:number}} [opts]
 * @returns {{pages:any[], visits:any[], report:{id:string,name:string,profile:string,status:string,count:number,error?:string}[], stats:{visits:number,pages:number,truncated:boolean}}}
 *   pages 是按天合并的页面（证据单位，一页一行）；visits 是逐次访问（切段用：同一页早上看一次、下午看一次是两段工作）
 */
export function collectBrowser(range, opts = {}) {
  const browsers = opts.browsers ?? detectBrowsers();
  const only = (opts.only ?? []).map((s) => String(s).toLowerCase());
  const maxPages = opts.maxPages ?? 500;
  const visits = [];
  const report = [];
  for (const b of browsers) {
    if (only.length && !only.includes(b.id)) continue;
    for (const p of b.profiles) {
      if (p.readable === false) {
        report.push({ id: b.id, name: b.name, profile: p.profile, status: 'denied', count: 0, error: p.error });
        continue;
      }
      try {
        const raws = readHistoryFile(p.file, b.kind, range);
        let n = 0;
        for (const raw of raws) {
          const v = normalizeVisit(raw, { excludeDomains: opts.excludeDomains });
          if (!v) continue;
          visits.push({ ...v, browser: b.name, profile: p.profile });
          n += 1;
        }
        report.push({ id: b.id, name: b.name, profile: p.profile, status: 'ok', count: n });
      } catch (err) {
        report.push({ id: b.id, name: b.name, profile: p.profile, status: 'failed', count: 0, error: err?.message ?? String(err) });
      }
    }
  }
  let pages = groupPages(visits);
  let truncated = false;
  if (pages.length > maxPages) {
    // 太多就留下访问最多、停留最久的那些，再按时间排回去
    truncated = true;
    pages = pages
      .sort((a, b) => b.visits - a.visits || b.secs - a.secs)
      .slice(0, maxPages)
      .sort((a, b) => a.firstTs.localeCompare(b.firstTs));
  }
  const kept = new Set(pages.map((p) => p.url));
  const keptVisits = visits.filter((v) => kept.has(v.url)).sort((a, b) => a.ts.localeCompare(b.ts));
  return { pages, visits: keptVisits, report, stats: { visits: visits.length, pages: pages.length, truncated } };
}
