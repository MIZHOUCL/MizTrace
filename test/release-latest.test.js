import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldMarkLatest } from '../scripts/release-latest.mjs';

test('最新下载跟随正式版本号，不受旧版本补发或测试版影响', () => {
  assert.equal(shouldMarkLatest('v0.5.1', ['v0.4.0', 'v0.5.0']), true);
  assert.equal(shouldMarkLatest('v0.4.1', ['v0.5.1', 'v0.4.0']), false);
  assert.equal(shouldMarkLatest('v0.10.0', ['v0.9.9']), true);
  assert.equal(shouldMarkLatest('v0.5.2-beta.1', ['v0.5.1']), false);
  assert.equal(shouldMarkLatest('v0.5.1', []), true);
});
