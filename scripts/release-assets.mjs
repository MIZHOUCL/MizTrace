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
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version;
const repository = process.env.GITHUB_REPOSITORY || 'MIZHOUCL/MizTrace';
const targets = process.platform === 'win32' ? [['.exe', 'MizTrace-Windows-x64-Setup.exe']] : [['.dmg', `MizTrace-macOS-${process.arch}.dmg`], ['.zip', `MizTrace-macOS-${process.arch}.zip`]];
const checksums = [];
for (const [ext, name] of targets) {
  const matches = files.filter((f) => f.toLowerCase().endsWith(ext));
  if (matches.length !== 1) throw new Error(`预期一个 ${ext} 安装包，实际 ${matches.length} 个，请先清理旧构建输出`);
  const target = path.join(dest, name);
  fs.copyFileSync(matches[0], target);
  checksums.push(`${crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')}  ${name}`);
}
if (process.platform === 'win32') {
  // Squirrel 的 RELEASES 引用原始 nupkg 文件名，不能只发布 Setup 或重命名 nupkg。
  const packages = files.filter((f) => path.basename(f) === `MizTrace-${version}-full.nupkg`);
  const releases = files.filter((f) => path.basename(f) === 'RELEASES');
  if (packages.length !== 1 || releases.length !== 1) throw new Error('缺少 Squirrel 更新包或 RELEASES');
  const packageName = path.basename(packages[0]);
  const line = fs.readFileSync(releases[0], 'utf8').trim().split(/\r?\n/).find((line) => line.split(/\s+/)[1] === packageName);
  const parts = line?.split(/\s+/);
  const buffer = fs.readFileSync(packages[0]);
  if (!parts || parts[0].toLowerCase() !== crypto.createHash('sha1').update(buffer).digest('hex') || Number(parts[2]) !== buffer.length) throw new Error('RELEASES 与更新包校验不一致');
  fs.copyFileSync(packages[0], path.join(dest, packageName));
  fs.writeFileSync(path.join(dest, 'RELEASES'), line + '\n');
  for (const name of [packageName, 'RELEASES']) checksums.push(`${crypto.createHash('sha256').update(fs.readFileSync(path.join(dest, name))).digest('hex')}  ${name}`);
} else if (process.platform === 'darwin') {
  const name = `update-darwin-${process.arch}.json`;
  const feed = { url: `https://github.com/${repository}/releases/download/v${version}/MizTrace-macOS-${process.arch}.zip`, name: `MizTrace ${version}`, notes: `MizTrace ${version}`, pub_date: new Date().toISOString() };
  fs.writeFileSync(path.join(dest, name), JSON.stringify(feed, null, 2));
  checksums.push(`${crypto.createHash('sha256').update(fs.readFileSync(path.join(dest, name))).digest('hex')}  ${name}`);
}
fs.writeFileSync(path.join(dest, `SHA256SUMS-${process.platform}-${process.arch}.txt`), checksums.join('\n') + '\n');
console.log(`Release assets: ${dest}`);
