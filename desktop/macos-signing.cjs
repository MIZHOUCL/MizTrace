const path = require('node:path');

// 手动构建可以预览；正式发布必须明确要求 Developer ID 签名和 Apple 公证。
function macSigningConfig({ platform = process.platform, env = process.env } = {}) {
  if (platform !== 'darwin') return {};
  const keys = ['APPLE_SIGNING_IDENTITY', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'];
  const missing = keys.filter((key) => !env[key]?.trim());
  const required = env.MIZTRACE_REQUIRE_MAC_SIGNING === '1';
  const configured = missing.length !== keys.length;
  if (missing.length) {
    if (required || configured) {
      throw new Error(`macOS 签名和公证配置不完整，缺少：${missing.join(', ')}。正式发布不能使用未签名安装包；请配置 Developer ID Application 证书和 Apple 公证凭据。`);
    }
    return {};
  }
  if (!env.APPLE_SIGNING_IDENTITY.startsWith('Developer ID Application:')) {
    throw new Error('macOS 下载分发必须使用 Developer ID Application 证书，不能使用临时签名或其他类型证书。');
  }
  return {
    osxSign: {
      identity: env.APPLE_SIGNING_IDENTITY,
      optionsForFile: () => ({ hardenedRuntime: true, entitlements: path.join(__dirname, 'entitlements.plist') }),
    },
    osxNotarize: {
      appleId: env.APPLE_ID,
      appleIdPassword: env.APPLE_APP_SPECIFIC_PASSWORD,
      teamId: env.APPLE_TEAM_ID,
    },
  };
}

module.exports = { macSigningConfig };
