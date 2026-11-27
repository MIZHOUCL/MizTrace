/** 为 GitHub Release 生成稳定的文件名，README 的 latest/download 链接无需逐版修改。 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const makeDir = path.join(root, 'desktop', 'out', 'make');
const dest = path.join(root, 'desktop', 'out', 'release');
fs.mkdirSync(dest, { recursive: true });
function walk(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]); }
const files = walk(makeDir);
const targets = process.platform === 'win32' ? [['.exe', 'MizTrace-Windows-x64-Setup.exe']] : [['.dmg', `MizTrace-macOS-${process.arch}.dmg`], ['.zip', `MizTrace-macOS-${process.arch}.zip`]];
const checksums = [];
for (const [ext, name] of targets) {
  const matches = files.filter((f) => f.toLowerCase().endsWith(ext));
  if (matches.length !== 1) throw new Error(`预期一个 ${ext} 安装包，实际 ${matches.length} 个，请先清理旧构建输出`);
  const target = path.join(dest, name);
  fs.copyFileSync(matches[0], target);
  checksums.push(`${crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')}  ${name}`);
}
fs.writeFileSync(path.join(dest, `SHA256SUMS-${process.platform}-${process.arch}.txt`), checksums.join('\n') + '\n');
console.log(`Release assets: ${dest}`);
