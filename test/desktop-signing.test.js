import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { macSigningConfig } = require('../desktop/macos-signing.cjs');
const credentials = {
  APPLE_SIGNING_IDENTITY: 'Developer ID Application: MizTrace (ABCDEFGHIJ)',
  APPLE_ID: 'build@example.invalid',
  APPLE_APP_SPECIFIC_PASSWORD: 'test-only-password',
  APPLE_TEAM_ID: 'ABCDEFGHIJ',
};

test('macOS 正式发布缺少签名凭据时失败，不能静默降级为未签名包', () => {
  assert.throws(() => macSigningConfig({ platform: 'darwin', env: { MIZTRACE_REQUIRE_MAC_SIGNING: '1' } }), /正式发布不能使用未签名安装包/);
});

test('只允许完全未配置凭据的手动构建作为本地预览', () => {
  assert.deepEqual(macSigningConfig({ platform: 'darwin', env: {} }), {});
  for (const key of Object.keys(credentials)) {
    assert.throws(() => macSigningConfig({ platform: 'darwin', env: { [key]: credentials[key] } }), /配置不完整/);
  }
});

test('macOS 签名与公证必须一起配置，报错不泄露凭据', () => {
  for (const key of Object.keys(credentials)) {
    const env = { ...credentials, [key]: '  ' };
    assert.throws(() => macSigningConfig({ platform: 'darwin', env }), (error) => {
      assert.match(error.message, new RegExp(key));
      assert.ok(!error.message.includes(credentials.APPLE_APP_SPECIFIC_PASSWORD));
      return true;
    });
  }
});

test('完整凭据启用 Developer ID 签名、hardened runtime 和 Apple 公证', () => {
  const config = macSigningConfig({ platform: 'darwin', env: { ...credentials, MIZTRACE_REQUIRE_MAC_SIGNING: '1' } });
  assert.equal(config.osxSign.identity, credentials.APPLE_SIGNING_IDENTITY);
  assert.equal(config.osxSign.optionsForFile().hardenedRuntime, true);
  assert.match(config.osxSign.optionsForFile().entitlements, /entitlements\.plist$/);
  assert.deepEqual(config.osxNotarize, {
    appleId: credentials.APPLE_ID,
    appleIdPassword: credentials.APPLE_APP_SPECIFIC_PASSWORD,
    teamId: credentials.APPLE_TEAM_ID,
  });
});

test('下载分发拒绝 ad-hoc 和 Apple Development 证书', () => {
  for (const identity of ['-', 'Apple Development: MizTrace (ABCDEFGHIJ)']) {
    assert.throws(() => macSigningConfig({ platform: 'darwin', env: { ...credentials, APPLE_SIGNING_IDENTITY: identity } }), /必须使用 Developer ID Application/);
  }
});

test('Windows 构建不依赖 Apple 凭据', () => {
  assert.deepEqual(macSigningConfig({ platform: 'win32', env: { MIZTRACE_REQUIRE_MAC_SIGNING: '1' } }), {});
});
