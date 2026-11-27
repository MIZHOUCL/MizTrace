/** 将核心与构建机上的 Node 一起带入安装包，终端用户无需安装运行环境。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const desktop = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(desktop);
const stage = path.join(desktop, '.build');
const rootPackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const desktopPackage = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8'));
if (rootPackage.version !== desktopPackage.version) throw new Error('根目录与 desktop/package.json 的版本号必须一致');
const runtime = process.env.MIZTRACE_NODE_BINARY || process.execPath;
const probe = spawnSync(runtime, ['--input-type=module', '-e', "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE probe(id INTEGER)'); db.close(); console.log(JSON.stringify({platform:process.platform,arch:process.arch,version:process.version}));"], { encoding: 'utf8', windowsHide: true });
if (probe.status !== 0) throw new Error(`Node 运行环境不支持 SQLite：${probe.stderr || probe.error}`);
const runtimeInfo = JSON.parse(probe.stdout.trim());
if (runtimeInfo.platform !== process.platform || runtimeInfo.arch !== process.arch) throw new Error('请在目标平台和架构上构建，避免打入错误的 Node 运行环境');
// 仅清理本脚本专用的构建目录。
if (path.dirname(path.resolve(stage)) !== desktop || path.basename(stage) !== '.build') throw new Error('构建目录校验失败');
fs.rmSync(stage, { recursive: true, force: true });
const core = path.join(stage, 'service', 'core');
fs.mkdirSync(core, { recursive: true });
for (const name of ['src', 'web']) fs.cpSync(path.join(root, name), path.join(core, name), { recursive: true });
fs.copyFileSync(path.join(root, 'package.json'), path.join(core, 'package.json'));
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(core, 'LICENSE'));
fs.copyFileSync(path.join(desktop, 'service.mjs'), path.join(stage, 'service', 'service.mjs'));
const runtimeDir = path.join(stage, 'runtime');
fs.mkdirSync(runtimeDir);
const binaryName = process.platform === 'win32' ? 'node.exe' : 'node';
fs.copyFileSync(runtime, path.join(runtimeDir, binaryName));
if (process.platform !== 'win32') fs.chmodSync(path.join(runtimeDir, binaryName), 0o755);
const licenseCandidates = [path.join(path.dirname(runtime), 'LICENSE'), path.resolve(path.dirname(runtime), '..', 'LICENSE'), path.resolve(path.dirname(runtime), '..', 'share', 'doc', 'node', 'LICENSE')];
const license = licenseCandidates.find((p) => fs.existsSync(p));
if (!license) throw new Error('未找到 Node 分发许可证，请使用 Node 官方发行包或 actions/setup-node 提供的 Node');
fs.copyFileSync(license, path.join(runtimeDir, 'NODE-LICENSE'));
fs.writeFileSync(path.join(runtimeDir, 'runtime.json'), JSON.stringify(runtimeInfo, null, 2));
console.log(`Bundled Node ${runtimeInfo.version} (${runtimeInfo.platform}-${runtimeInfo.arch}) with SQLite support.`);
