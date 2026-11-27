const path = require('node:path');
module.exports = {
  packagerConfig: {
    name: 'MizTrace', executableName: 'MizTrace', appBundleId: 'com.miztrace.desktop',
    asar: true,
    extraResource: [path.join(__dirname, '.build', 'service'), path.join(__dirname, '.build', 'runtime')],
    ignore: (file) => file !== '' && !/^\/(package\.json|main\.cjs|navigation\.cjs|node_modules)(\/|$)/.test(file.replace(/\\/g, '/')),
  },
  rebuildConfig: {},
  makers: [
    { name: '@electron-forge/maker-squirrel', config: { name: 'MizTrace', setupExe: 'MizTrace-Windows-x64-Setup.exe', noMsi: true } },
    { name: '@electron-forge/maker-zip', platforms: ['darwin'] },
    { name: '@electron-forge/maker-dmg', config: { format: 'ULFO' } },
  ],
};
