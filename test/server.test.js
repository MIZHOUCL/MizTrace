import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startServer } from '../src/server/index.js';
import { DEFAULTS } from '../src/config.js';

/** 有些沙箱禁止 listen（EPERM）。探测一次，不行就跳过这组测试而不是误报失败。 */
const canListen = await new Promise((resolve) => {
  const s = http.createServer();
  s.once('error', () => resolve(false));
  s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)));
});
const SKIP = canListen ? false : '当前环境不允许监听 127.0.0.1（沙箱 EPERM），server 测试在 CI 上运行';

async function boot(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miztrace-srv-'));
  process.env.MIZTRACE_DATA_DIR = dir; // saveConfig 会写到这里
  const cfg = JSON.parse(JSON.stringify(DEFAULTS));
  cfg.roots = [dir];
  cfg.out = path.join(dir, 'out');
  cfg.cutoffHour = 4;
  cfg.sessionDirs = { 'claude-code': [path.join(dir, 'none')], codex: [path.join(dir, 'none')] };
  cfg.effectiveTimezone = 'UTC';
  Object.assign(cfg, extra); // 个别用例要改 managedDevice 之类的顶层开关
  const srv = await startServer({ cfg, port: 0, open: false, dbFile: ':memory:' });
  const call = (method, p, body, headers = {}) =>
    fetch(`http://127.0.0.1:${srv.port}${p}`, { method, headers: { 'content-type': 'application/json', 'x-miztrace-token': srv.token, ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { srv, call, dir, cfg };
}

test('静态页面可访问，带 CSP；API 无 token → 401；错 Host → 403', { skip: SKIP }, async () => {
  const { srv, call, dir } = await boot();
  try {
    const page = await fetch(`http://127.0.0.1:${srv.port}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
    assert.match(await page.text(), /vue\.global\.prod\.js/);
    const noTok = await fetch(`http://127.0.0.1:${srv.port}/api/state`);
    assert.equal(noTok.status, 401);
    const badHost = await fetch(`http://127.0.0.1:${srv.port}/api/state`, { headers: { host: 'evil.example.com', 'x-miztrace-token': srv.token } });
    assert.equal(badHost.status, 403);
    const badOrigin = await fetch(`http://127.0.0.1:${srv.port}/api/state`, { headers: { origin: 'https://evil.example.com', 'x-miztrace-token': srv.token } });
    assert.equal(badOrigin.status, 403);
    const traversal = await fetch(`http://127.0.0.1:${srv.port}/../package.json`);
    assert.equal(traversal.status, 404);
    const ok = await call('GET', '/api/state');
    assert.equal(ok.status, 200);
    const j = await ok.json();
    assert.equal(j.config.ai.hasApiKey, false);
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('day → override → journal → save 一条链路；config 保存不会抹掉 key，输出只带掩码', { skip: SKIP }, async () => {
  const { srv, call, dir } = await boot();
  try {
    fs.writeFileSync(path.join(dir, 'notes.md'), 'x');
    const day = await (await call('GET', '/api/day?date=' + new Date().toISOString().slice(0, 10))).json();
    assert.ok(Array.isArray(day.modules));
    const date = day.localDate;
    if (day.modules.length) {
      const m = day.modules[0];
      const r = await (await call('POST', '/api/day/override', { date, key: m.key, selected: false })).json();
      assert.equal(r.overrides[m.key], false);
      const again = await (await call('GET', `/api/day?date=${date}`)).json();
      assert.equal(again.modules.find((x) => x.key === m.key).selected, false, '刷新后选择仍在');
    }
    const jr = await (await call('GET', `/api/journal?date=${date}`)).json();
    assert.match(jr.markdown, new RegExp(`^# ${date}`));
    const saved = await (await call('POST', '/api/save', { date, markdown: '# 手写\n\n内容' })).json();
    assert.ok(saved.ok && fs.existsSync(saved.path));

    const put = await (await call('PUT', '/api/config', { ai: { enabled: true, baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-REALKEY1234567890abcdef', model: 'deepseek-chat' } })).json();
    assert.equal(put.ai.hasApiKey, true);
    assert.match(put.ai.apiKey, /^\*+cdef$/, '只返回掩码');
    const put2 = await (await call('PUT', '/api/config', { ai: { model: 'deepseek-reasoner', apiKey: '' } })).json();
    assert.equal(put2.ai.model, 'deepseek-reasoner');
    assert.equal(put2.ai.hasApiKey, true, '空 key 不覆盖已有 key');
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    assert.equal(onDisk.ai.apiKey, 'sk-REALKEY1234567890abcdef');
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'config.json')).mode & 0o777, 0o600);

    const pv = await (await call('POST', '/api/write/preview', { date })).json();
    assert.ok(typeof pv.estTokens === 'number');
    assert.ok(!JSON.stringify(pv).includes('REALKEY'), '预览里不能出现 key');
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.MIZTRACE_DATA_DIR;
  }
});

test('受管设备：managedDevice=true 时一切外发被拒绝，规则版日记照常', { skip: SKIP }, async () => {
  const { srv, call, dir } = await boot({ managedDevice: true, ai: { ...DEFAULTS.ai, enabled: true, baseUrl: 'https://x.example/v1', apiKey: 'sk-REALKEY1234567890abcdef', model: 'm' } });
  try {
    const date = new Date().toISOString().slice(0, 10);
    const t = await call('POST', '/api/ai/test', { ai: {} });
    assert.equal(t.status, 500);
    assert.match((await t.json()).error, /managedDevice/);
    const w = await call('POST', '/api/write', { date });
    assert.equal(w.status, 500);
    assert.match((await w.json()).error, /managedDevice/);
    const pv = await (await call('POST', '/api/write/preview', { date })).json();
    assert.equal(pv.managedDevice, true, '预览要告诉前端这是受管设备');
    const jr = await call('GET', `/api/journal?date=${date}`);
    assert.equal(jr.status, 200, '规则版不联网，不受影响');
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.MIZTRACE_DATA_DIR;
  }
});

test('每个泡泡可存写法要求：写入后 /api/day 带回来，预览的 prompt 里出现；设置里的整篇写作要求也进预览', { skip: SKIP }, async () => {
  const { srv, call, dir } = await boot();
  try {
    fs.writeFileSync(path.join(dir, 'notes.md'), 'x');
    const day = await (await call('GET', '/api/day?date=' + new Date().toISOString().slice(0, 10))).json();
    const date = day.localDate;
    assert.deepEqual(day.hints, {});
    const key = day.modules[0]?.key ?? 'ghost@2026';
    const r = await (await call('POST', '/api/day/hint', { date, key, hint: '只写结论' })).json();
    assert.equal(r.hints[key], '只写结论');
    const again = await (await call('GET', `/api/day?date=${date}`)).json();
    assert.equal(again.hints[key], '只写结论');
    const put = await (await call('PUT', '/api/config', { ai: { style: '口语一点' } })).json();
    assert.equal(put.ai.style, '口语一点');
    if (again.modules.length) {
      assert.equal(again.modules.find((m) => m.key === key).hint, '只写结论', '模块自己带着要求回来');
      await call('POST', '/api/day/override', { date, key, selected: true }); // 杂项默认排除，选上才会进 prompt
      const pv = await (await call('POST', '/api/write/preview', { date })).json();
      assert.equal(pv.hintCount, 1);
      assert.equal(pv.hasStyle, true);
      assert.match(pv.user, /补充说明（亲手写的，最可信，优先于下面的证据）：只写结论/);
      assert.match(pv.user, /整篇写作要求：口语一点/);
    }
    const cleared = await (await call('POST', '/api/day/hint', { date, key, hint: '' })).json();
    assert.equal(cleared.hints[key], undefined);
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.MIZTRACE_DATA_DIR;
  }
});
