import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const { newerVersion, releaseInfo, createUpdater } = createRequire(import.meta.url)('../desktop/updater.cjs');
const base = 'https://github.com/MIZHOUCL/MizTrace/releases/download/v0.5.0/';
const asset = (name) => ({ name, browser_download_url: base + name, state: 'uploaded', size: 1000 });
const release = () => ({ tag_name: 'v0.5.0', name: '新版', published_at: '2026-11-27T08:00:00Z', body: '## 更新说明\n- 日记库', assets: ['RELEASES', 'MizTrace-0.5.0-full.nupkg', 'MizTrace-macOS-arm64.zip', 'update-darwin-arm64.json'].map(asset) });
function fixture(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miztrace-update-test-'));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  const native = new EventEmitter(); let downloads = 0, restarts = 0, requests = 0;
  native.setFeedURL = (feed) => { native.feed = feed; }; native.checkForUpdates = () => downloads++;
  const prefs = path.join(dir, 'prefs.json');
  const options = { autoUpdater: native, version: '0.4.0', platform: 'win32', arch: 'x64', preferencesFile: prefs,
    fetchImpl: async () => { requests++; return { ok: true, text: async () => JSON.stringify(release()) }; },
    restart: async (starting) => { starting(); restarts++; return true; }, ...extra };
  return { updater: createUpdater(options), native, prefs, options, counts: () => ({ downloads, restarts, requests }) };
}
test('版本比较按数值、不降级、不接受预发布，支持 dev 到稳定版', () => {
  assert.ok(newerVersion('v0.10.0', '0.9.9'));
  assert.ok(newerVersion('v0.4.0', '0.4.0-dev'));
  for (const v of ['0.3.9', '0.4.0', '0.5.0-beta', 'evil']) assert.equal(newerVersion(v, '0.4.0'), false);
});
test('发布资产限制仓库和标签，缺失或错误的包不会启用更新', () => {
  assert.equal(releaseInfo(release(), '0.4.0', 'win32', 'x64').feed, base);
  assert.equal(releaseInfo(release(), '0.4.0', 'darwin', 'arm64').feed, base + 'update-darwin-arm64.json');
  assert.equal(releaseInfo(release(), '0.4.0', 'darwin', 'x64').feed, null);
  const tampered = release(); tampered.assets[1].browser_download_url = 'https://evil.test/a';
  assert.equal(releaseInfo(tampered, '0.4.0', 'win32', 'x64').feed, null);
  assert.equal(releaseInfo({ ...release(), draft: true }, '0.4.0', 'win32', 'x64'), null);
});
test('小版本更新也需要新发行版：0.5.2 能发现完整的 0.5.3，不能把同版本重传当成更新', async (t) => {
  const next = { ...release(), tag_name: 'v0.5.3', assets: ['RELEASES', 'MizTrace-0.5.3-full.nupkg'].map((name) => ({
    name, browser_download_url: `https://github.com/MIZHOUCL/MizTrace/releases/download/v0.5.3/${name}`, state: 'uploaded', size: 1000,
  })) };
  const { updater, native, counts } = fixture(t, { version: '0.5.2', fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify(next) }) });
  const state = await updater.check();
  assert.equal(state.phase, 'available'); assert.equal(state.release.version, '0.5.3');
  assert.equal(counts().downloads, 0);
  await updater.download();
  assert.equal(native.feed.url, 'https://github.com/MIZHOUCL/MizTrace/releases/download/v0.5.3/');
  assert.equal(releaseInfo(next, '0.5.3', 'win32', 'x64'), null);
  assert.equal(releaseInfo({ ...next, draft: true }, '0.5.2', 'win32', 'x64'), null);
  assert.equal(releaseInfo(next, '0.5.2', 'darwin', 'arm64').feed, null);
});
test('检查只获取说明，明确下载后才触发原生更新，重复点击无重复下载', async (t) => {
  const { updater, native, counts } = fixture(t);
  const state = await updater.check();
  assert.equal(state.phase, 'available'); assert.match(state.release.notes, /日记库/);
  assert.equal(state.release.date, '2026-11-27T08:00:00Z');
  assert.equal(counts().downloads, 0);
  await Promise.all([updater.download(), updater.download()]);
  assert.equal(counts().downloads, 1); assert.equal(native.feed.url, base);
  await updater.check(); assert.equal(counts().requests, 1);
  await updater.install(); assert.equal(counts().restarts, 0);
  native.emit('update-downloaded'); assert.equal(updater.snapshot().phase, 'downloaded');
  await updater.install(); assert.equal(counts().restarts, 1);
});
test('未保存编辑阻止重启；下载失败可以重试；偏好持久化', async (t) => {
  const { updater, native, prefs, counts, options } = fixture(t, { restart: async () => false });
  await updater.check(); await updater.download();
  native.emit('error', new Error('网络断开')); assert.equal(updater.snapshot().phase, 'error');
  await updater.download(); assert.equal(counts().downloads, 2);
  native.emit('update-downloaded'); await updater.install();
  assert.equal(updater.snapshot().phase, 'downloaded'); assert.match(updater.snapshot().error, /先保存/);
  updater.setAutoCheck(false); assert.equal(JSON.parse(fs.readFileSync(prefs)).autoCheck, false);
  assert.equal(createUpdater({ ...options, autoUpdater: new EventEmitter() }).snapshot().autoCheck, false);
});
test('安装请求等待编辑确认时，重复点击不会再次重启', async (t) => {
  let unblock, attempts = 0;
  const { updater, native } = fixture(t, { restart: async (starting) => { attempts++; await new Promise((r) => { unblock = r; }); starting(); return true; } });
  await updater.check(); await updater.download(); native.emit('update-downloaded');
  const install = updater.install();
  await updater.install();
  assert.equal(attempts, 1);
  unblock(); await install;
});
test('受管设备不联网，未签名或未安装版本不触发原生下载，404 与限流可理解', async (t) => {
  const restricted = fixture(t, { managed: () => true });
  await restricted.updater.check(); await restricted.updater.download(); assert.equal(restricted.counts().requests, 0);
  const unsigned = fixture(t, { supportError: () => '未签名' });
  await unsigned.updater.check(); await unsigned.updater.download(); assert.equal(unsigned.counts().downloads, 0);
  const missing = fixture(t, { fetchImpl: async () => ({ status: 404 }) });
  assert.equal((await missing.updater.check()).phase, 'no-release');
  const limited = fixture(t, { fetchImpl: async () => ({ status: 403, ok: false }) });
  assert.match((await limited.updater.check()).error, /受限/);
});
