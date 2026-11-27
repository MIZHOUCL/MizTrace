import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readHistoryFile, normalizeVisit, groupPages, collectBrowser, detectBrowsers, searchTermOf } from '../src/collect/browser.js';
import { dayRange } from '../src/time.js';

const RANGE = dayRange('2026-09-09', 4); // UTC+8 机器上是 09-08T20:00Z ～ 09-09T20:00Z；按 UTC 跑也在窗口内
const IN = Date.parse('2026-09-09T06:30:00.000Z');
const OUT = Date.parse('2026-08-01T06:30:00.000Z');
const CHROME_EPOCH = 11_644_473_600_000n;

function tmp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `miztrace-${name}-`));
}

function chromiumDb(file, visits, terms = []) {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE urls(id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER DEFAULT 0, typed_count INTEGER DEFAULT 0, last_visit_time INTEGER NOT NULL, hidden INTEGER DEFAULT 0);
           CREATE TABLE visits(id INTEGER PRIMARY KEY, url INTEGER NOT NULL, visit_time INTEGER NOT NULL, transition INTEGER DEFAULT 0, visit_duration INTEGER DEFAULT 0);
           CREATE TABLE keyword_search_terms(keyword_id INTEGER, url_id INTEGER, term TEXT, normalized_term TEXT);`);
  const ins = db.prepare('INSERT INTO urls (id, url, title, last_visit_time, hidden) VALUES (?, ?, ?, ?, ?)');
  const vis = db.prepare('INSERT INTO visits (url, visit_time, transition, visit_duration) VALUES (?, ?, ?, ?)');
  visits.forEach((v, i) => {
    const t = (BigInt(v.ms) + CHROME_EPOCH) * 1000n;
    ins.run(i + 1, v.url, v.title ?? '', t, v.hidden ? 1 : 0);
    vis.run(i + 1, t, v.transition ?? 0, BigInt((v.secs ?? 0) * 1_000_000));
  });
  for (const t of terms) db.prepare('INSERT INTO keyword_search_terms VALUES (1, ?, ?, ?)').run(t.urlId, t.term, t.term.toLowerCase());
  db.close();
}

test('Chromium History：时间戳换算在 SQL 里做，窗口外与 iframe/刷新访问不算', () => {
  const dir = tmp('chromium');
  const file = path.join(dir, 'History');
  chromiumDb(
    file,
    [
      { url: 'https://learn.microsoft.com/zh-cn/sql/t-sql', title: 'T-SQL 参考', ms: IN, secs: 42 },
      { url: 'https://example.com/old', title: '上个月', ms: OUT },
      { url: 'https://ads.example.com/frame', title: '广告', ms: IN + 1000, transition: 3 },
      { url: 'https://learn.microsoft.com/zh-cn/sql/t-sql', title: 'T-SQL 参考', ms: IN + 2000, transition: 8 },
      { url: 'https://cn.bing.com/search?q=deepseek+harness&form=X', title: 'deepseek harness - 搜索', ms: IN + 3000, transition: 5 },
    ],
    [{ urlId: 5, term: 'deepseek harness' }],
  );
  const rows = readHistoryFile(file, 'chromium', RANGE);
  assert.deepEqual(
    rows.map((r) => r.url),
    ['https://learn.microsoft.com/zh-cn/sql/t-sql', 'https://cn.bing.com/search?q=deepseek+harness&form=X'],
  );
  assert.equal(rows[0].ms, IN, '微秒 → 毫秒，精确到毫秒');
  assert.equal(rows[0].secs, 42);
  assert.equal(rows[1].term, 'deepseek harness', 'keyword_search_terms 里的搜索词跟着访问走');
  assert.ok(!fs.readdirSync(os.tmpdir()).some((n) => n.startsWith('miztrace-') && n.endsWith('-History')), '临时副本读完即删');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Firefox places.sqlite 与 Safari History.db 也能读', () => {
  const dir = tmp('ff');
  const ff = path.join(dir, 'places.sqlite');
  {
    const db = new DatabaseSync(ff);
    db.exec('CREATE TABLE moz_places(id INTEGER PRIMARY KEY, url TEXT, title TEXT); CREATE TABLE moz_historyvisits(id INTEGER PRIMARY KEY, place_id INTEGER, visit_date INTEGER, visit_type INTEGER)');
    db.prepare('INSERT INTO moz_places VALUES (1, ?, ?)').run('https://developer.mozilla.org/zh-CN/', 'MDN');
    db.prepare('INSERT INTO moz_historyvisits VALUES (1, 1, ?, 1)').run(IN * 1000);
    db.prepare('INSERT INTO moz_historyvisits VALUES (2, 1, ?, 9)').run((IN + 5000) * 1000); // reload
    db.prepare('INSERT INTO moz_historyvisits VALUES (3, 1, ?, 1)').run(OUT * 1000);
    db.close();
  }
  const rows = readHistoryFile(ff, 'firefox', RANGE);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ms, IN);
  assert.equal(rows[0].title, 'MDN');

  const sf = path.join(dir, 'History.db');
  {
    const db = new DatabaseSync(sf);
    db.exec('CREATE TABLE history_items(id INTEGER PRIMARY KEY, url TEXT); CREATE TABLE history_visits(id INTEGER PRIMARY KEY, history_item INTEGER, visit_time REAL, title TEXT)');
    db.prepare('INSERT INTO history_items VALUES (1, ?)').run('https://developer.apple.com/documentation/');
    db.prepare('INSERT INTO history_visits VALUES (1, 1, ?, ?)').run(IN / 1000 - 978307200, 'Apple Developer');
    db.prepare('INSERT INTO history_visits VALUES (2, 1, ?, ?)').run(OUT / 1000 - 978307200, 'old');
    db.close();
  }
  const s = readHistoryFile(sf, 'safari', RANGE);
  assert.equal(s.length, 1);
  assert.equal(s[0].ms, IN);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('normalizeVisit：去参数、去内部页、登录域名与排除域名不记、搜索词单独提出、file:// 当本地文件', () => {
  const at = (url, extra = {}) => normalizeVisit({ url, title: extra.title ?? 'T', ms: IN, ...extra }, extra.opts);
  assert.equal(at('https://github.com/MIZHOUCL/MizTrace?tab=readme#top').url, 'https://github.com/MIZHOUCL/MizTrace');
  assert.equal(at('https://www.example.com/a').host, 'example.com', '去掉 www.');
  assert.equal(at('chrome://newtab/'), null);
  assert.equal(at('edge://settings/'), null);
  assert.equal(at('https://accounts.google.com/signin'), null, '登录页不记');
  assert.equal(at('https://login.example.com/x'), null);
  assert.equal(at('https://www.bilibili.com/video/x', { opts: { excludeDomains: ['bilibili.com'] } }), null);
  assert.equal(at('https://m.bilibili.com/video/x', { opts: { excludeDomains: ['bilibili.com'] } }), null, '子域名也排除');
  const search = at('https://www.google.com/search?q=node+sqlite+bigint&hl=zh');
  assert.equal(search.term, 'node sqlite bigint');
  assert.equal(search.title, '搜索「node sqlite bigint」');
  assert.equal(search.url, 'https://www.google.com/search?q=node%20sqlite%20bigint', '搜索页只保留搜索词，不同搜索不会被合并');
  const bing = at('https://cn.bing.com/search?form=X&pq=x', { term: 'deepseek harness' });
  assert.equal(bing.term, 'deepseek harness', '浏览器自己记的搜索词优先');
  assert.equal(at('https://www.baidu.com/s?wd=%E9%87%91%E8%9D%B6+FormId').term, '金蝶 FormId');
  const f = at('file:///D:/docs/%E6%96%B9%E6%A1%88.pdf', { title: '' });
  assert.equal(f.host, '本地文件');
  assert.equal(f.url, 'D:/docs/方案.pdf');
  assert.equal(f.title, '方案.pdf');
  assert.equal(at('http://127.0.0.1:8765/', { title: 'MizTrace' }), null, '不把自己记进去');
  assert.equal(at('http://localhost:3000/', { title: 'My App' }).host, 'localhost', '本地开发服务器是真实工作');
  assert.equal(at('https://example.com/', { title: '' }).title, 'example.com', '没标题就用域名');
  assert.equal(searchTermOf(new URL('https://duckduckgo.com/?q=abc')), 'abc');
});

test('groupPages：同一页面一天多次访问合并成一条，保留首末时间与次数', () => {
  const v = (ms, url, title = 'T', secs = 1) => ({ ts: new Date(ms).toISOString(), url, host: 'x.com', title, term: null, secs, browser: 'Edge', profile: 'Default' });
  const pages = groupPages([v(IN + 9000, 'https://x.com/a', '短'), v(IN, 'https://x.com/a', '长一点的标题', 5), v(IN + 1000, 'https://x.com/b')]);
  assert.equal(pages.length, 2);
  assert.equal(pages[0].url, 'https://x.com/a', '按首次访问排序');
  assert.equal(pages[0].visits, 2);
  assert.equal(pages[0].secs, 6);
  assert.equal(pages[0].title, '长一点的标题', '标题取信息量最大的那个');
  assert.equal(pages[0].firstTs, new Date(IN).toISOString());
  assert.equal(pages[0].lastTs, new Date(IN + 9000).toISOString());
});

test('collectBrowser：多浏览器合并、不可读的 profile 报 denied、超过上限留访问最多的', () => {
  const dir = tmp('collect');
  const file = path.join(dir, 'History');
  const visits = [];
  for (let i = 0; i < 12; i += 1) visits.push({ url: `https://site.com/p${i}`, title: `P${i}`, ms: IN + i * 60_000 });
  visits.push({ url: 'https://site.com/p1', title: 'P1', ms: IN + 30 * 60_000 });
  visits.push({ url: 'https://site.com/p1', title: 'P1', ms: IN + 31 * 60_000 });
  chromiumDb(file, visits);
  const browsers = [
    { id: 'edge', name: 'Edge', kind: 'chromium', profiles: [{ profile: 'Default', file, readable: true }] },
    { id: 'safari', name: 'Safari', kind: 'safari', profiles: [{ profile: 'Default', file: '/nope', readable: false, error: '没有读取权限' }] },
    { id: 'chrome', name: 'Chrome', kind: 'chromium', profiles: [{ profile: 'Default', file: path.join(dir, 'missing'), readable: true }] },
  ];
  const r = collectBrowser(RANGE, { browsers, maxPages: 5 });
  assert.equal(r.stats.visits, 14);
  assert.equal(r.stats.pages, 5);
  assert.equal(r.stats.truncated, true);
  assert.ok(r.pages.some((p) => p.url === 'https://site.com/p1' && p.visits === 3), '访问最多的页面一定留下');
  assert.deepEqual(r.pages.map((p) => p.firstTs), [...r.pages.map((p) => p.firstTs)].sort(), '截断后仍按时间排');
  assert.equal(r.report.find((x) => x.id === 'safari').status, 'denied');
  assert.equal(r.report.find((x) => x.id === 'chrome').status, 'failed', '文件不存在也不能让整次采集崩掉');
  assert.equal(r.report.find((x) => x.id === 'edge').count, 14);
  assert.equal(r.visits.length, 3 + 4, '逐次访问只保留被留下的页面：p1 三次 + 其余四页各一次');
  assert.deepEqual(r.visits.map((v) => v.ts), [...r.visits.map((v) => v.ts)].sort());
  const only = collectBrowser(RANGE, { browsers, only: ['safari'] });
  assert.equal(only.pages.length, 0, 'only 限定浏览器');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('detectBrowsers：按平台找 profile，Local State 里的名字优先，不可读的标出来', () => {
  const home = tmp('home');
  const chrome = path.join(home, 'Library/Application Support/Google/Chrome');
  fs.mkdirSync(path.join(chrome, 'Default'), { recursive: true });
  fs.mkdirSync(path.join(chrome, 'Profile 2'), { recursive: true });
  fs.mkdirSync(path.join(chrome, 'System Profile'), { recursive: true });
  for (const p of ['Default', 'Profile 2', 'System Profile']) fs.writeFileSync(path.join(chrome, p, 'History'), 'x');
  fs.writeFileSync(path.join(chrome, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: '工作' } } } }));
  const ff = path.join(home, 'Library/Application Support/Firefox/Profiles/abcd1234.default-release');
  fs.mkdirSync(ff, { recursive: true });
  fs.writeFileSync(path.join(ff, 'places.sqlite'), 'x');
  const found = detectBrowsers({ home, platform: 'darwin', env: {} });
  const ids = found.map((b) => b.id);
  assert.deepEqual(ids, ['chrome', 'firefox']);
  assert.deepEqual(found[0].profiles.map((p) => p.profile), ['工作', 'Profile 2'], 'System Profile 不算，Local State 里的名字优先');
  assert.ok(found[0].profiles.every((p) => p.readable));
  assert.equal(found[1].profiles[0].profile, 'default-release');

  const winHome = tmp('winhome');
  const local = path.join(winHome, 'AppData/Local');
  fs.mkdirSync(path.join(local, 'Microsoft/Edge/User Data/Default'), { recursive: true });
  fs.writeFileSync(path.join(local, 'Microsoft/Edge/User Data/Default/History'), 'x');
  const win = detectBrowsers({ home: winHome, platform: 'win32', env: { LOCALAPPDATA: local } });
  assert.deepEqual(win.map((b) => b.id), ['edge']);
  assert.deepEqual(detectBrowsers({ home: winHome, platform: 'win32', env: {} }), [], '环境变量缺失时不猜路径');
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(winHome, { recursive: true, force: true });
});
