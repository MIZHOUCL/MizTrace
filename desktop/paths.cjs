const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 在创建 Chromium profile 之前选择数据目录，继续复用旧版 daytrace 数据。
function desktopDataDir({ env = process.env, platform = process.platform, home = os.homedir(), exists = fs.existsSync } = {}) {
  if (env.MIZTRACE_DATA_DIR) return env.MIZTRACE_DATA_DIR;
  if (env.DAYTRACE_DATA_DIR) return env.DAYTRACE_DATA_DIR;
  const base = platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : platform === 'win32' ? env.APPDATA || path.join(home, 'AppData', 'Roaming') : env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  const fresh = path.join(base, 'miztrace'), legacy = path.join(base, 'daytrace');
  return !exists(fresh) && exists(legacy) ? legacy : fresh;
}
module.exports = { desktopDataDir };
