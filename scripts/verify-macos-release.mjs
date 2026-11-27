/** 正式发行前检查下载分发信任；直接启动的冒烟测试不能代替 Gatekeeper。 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('macOS 分发验证必须在 Mac 上执行。');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = path.resolve(process.argv[2] || path.join(root, 'desktop', 'out', `MizTrace-darwin-${process.arch}`, 'MizTrace.app'));
if (!fs.existsSync(app)) throw new Error(`未找到打包后的应用：${app}`);

function check(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120_000 });
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} 失败：${result.error?.message || result.signal || result.status}\n${output}`);
  }
  return output;
}

check('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
const details = check('/usr/bin/codesign', ['--display', '--verbose=4', app]);
if (!/^Authority=Developer ID Application:/m.test(details) || !/^TeamIdentifier=[A-Z0-9]{10}$/m.test(details)) {
  throw new Error('应用缺少有效的 Developer ID Application 签名；临时签名只能用于本机测试，不能作为正式 macOS 安装包发布。');
}
// 验证随应用携带的公证票据，让首次离线运行也能接受系统检查。
check('/usr/bin/xcrun', ['stapler', 'validate', app]);
check('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', app]);
console.log(`macOS distribution verification passed: ${app}`);
