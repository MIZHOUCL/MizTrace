const path = require('node:path');
const { macSigningConfig } = require('./macos-signing.cjs');
const iconDir = process.env.MIZTRACE_BUILD_ICON_DIR || path.join(__dirname, 'icons');
module.exports = {
  packagerConfig: {
    name: 'MizTrace', executableName: 'MizTrace', appBundleId: 'com.miztrace.desktop',
    icon: path.join(iconDir, 'miztrace'),
    asar: true,
    extraResource: [path.join(__dirname, '.build', 'service'), path.join(__dirname, '.build', 'runtime')],
    ignore: (file) => file !== '' && !/^\/(package\.json|LICENSE|main\.cjs|preload\.cjs|updater\.cjs|navigation\.cjs|paths\.cjs|node_modules)(\/|$)/.test(file.replace(/\\/g, '/')),
    ...macSigningConfig(),
  },
  rebuildConfig: {},
  makers: [
    { name: '@electron-forge/maker-squirrel', config: { name: 'MizTrace', setupExe: 'MizTrace-Windows-x64-Setup.exe', setupIcon: path.join(iconDir, 'miztrace.ico'), noMsi: true } },
    { name: '@electron-forge/maker-zip', platforms: ['darwin'] },
    { name: '@electron-forge/maker-dmg', config: { format: 'ULFO' } },
  ],
};
