const path = require('node:path');
const iconDir = process.env.MIZTRACE_BUILD_ICON_DIR || path.join(__dirname, 'icons');
module.exports = {
  packagerConfig: {
    name: 'MizTrace', executableName: 'MizTrace', appBundleId: 'com.miztrace.desktop',
    icon: path.join(iconDir, 'miztrace'),
    asar: true,
    extraResource: [path.join(__dirname, '.build', 'service'), path.join(__dirname, '.build', 'runtime')],
    ignore: (file) => file !== '' && !/^\/(package\.json|main\.cjs|preload\.cjs|updater\.cjs|navigation\.cjs|paths\.cjs|node_modules)(\/|$)/.test(file.replace(/\\/g, '/')),
    ...(process.platform === 'darwin' && process.env.APPLE_SIGNING_IDENTITY ? {
      osxSign: { identity: process.env.APPLE_SIGNING_IDENTITY, optionsForFile: () => ({ hardenedRuntime: true, entitlements: path.join(__dirname, 'entitlements.plist') }) },
      osxNotarize: { appleId: process.env.APPLE_ID, appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD, teamId: process.env.APPLE_TEAM_ID },
    } : {}),
  },
  rebuildConfig: {},
  makers: [
    { name: '@electron-forge/maker-squirrel', config: { name: 'MizTrace', setupExe: 'MizTrace-Windows-x64-Setup.exe', setupIcon: path.join(iconDir, 'miztrace.ico'), noMsi: true } },
    { name: '@electron-forge/maker-zip', platforms: ['darwin'] },
    { name: '@electron-forge/maker-dmg', config: { format: 'ULFO' } },
  ],
};
