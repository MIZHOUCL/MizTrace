import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isAppUrl, externalUrlAllowed } = require('../desktop/navigation.cjs');
const { desktopDataDir } = require('../desktop/paths.cjs');

test('桌面导航只允许当前本地 origin，外链只允许浏览器可打开的安全协议', () => {
  const origin = 'http://127.0.0.1:12345';
  assert.ok(isAppUrl(origin + '/?t=abc', origin));
  for (const url of ['http://127.0.0.1:9999/', 'http://evil.test', 'file:///etc/passwd', 'javascript:alert(1)', 'not a url']) assert.equal(isAppUrl(url, origin), false);
  for (const url of ['https://example.com', 'http://example.com', 'mailto:hello@example.com']) assert.ok(externalUrlAllowed(url));
  for (const url of ['file:///C:/secret', 'javascript:alert(1)', 'data:text/html,hi', 'ms-settings:', 'https://user:pass@example.com']) assert.equal(externalUrlAllowed(url), false);
});
test('桌面 profile 创建前复用旧版 daytrace 数据目录，显式目录优先', () => {
  const opts = { env: {}, home: '/fixture', platform: 'darwin', exists: (p) => p.endsWith('daytrace') };
  assert.equal(desktopDataDir(opts), path.join('/fixture', 'Library', 'Application Support', 'daytrace'));
  assert.equal(desktopDataDir({ ...opts, exists: () => false }), path.join('/fixture', 'Library', 'Application Support', 'miztrace'));
  assert.equal(desktopDataDir({ ...opts, env: { MIZTRACE_DATA_DIR: 'explicit' } }), 'explicit');
});
test('桌面与核心版本一致，构建包包含所有主进程文件', () => {
  const root = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)));
  const desktop = JSON.parse(fs.readFileSync(new URL('../desktop/package.json', import.meta.url)));
  const lock = JSON.parse(fs.readFileSync(new URL('../desktop/package-lock.json', import.meta.url)));
  assert.equal(root.version, desktop.version);
  assert.equal(lock.version, desktop.version);
  assert.equal(lock.packages[''].version, desktop.version);
  assert.equal(root.license, 'SEE LICENSE IN LICENSE');
  assert.equal(desktop.license, root.license);
  assert.equal(fs.readFileSync(new URL('../desktop/LICENSE', import.meta.url), 'utf8'), fs.readFileSync(new URL('../LICENSE', import.meta.url), 'utf8'));
  const config = require('../desktop/forge.config.cjs');
  for (const file of ['/main.cjs', '/preload.cjs', '/updater.cjs', '/navigation.cjs', '/paths.cjs', '/package.json', '/LICENSE']) assert.equal(config.packagerConfig.ignore(file), false);
  for (const file of ['/.build/core/test.db', '/out/private.txt', '/icons/miztrace.png']) assert.equal(config.packagerConfig.ignore(file), true);
});
