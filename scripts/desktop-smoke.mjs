/** 在隔离目录中启动真正打包后的 App，验证内置 Node、SQLite 和本地页面。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, defaultSessionDirs } from '../src/config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const folder = path.join(root, 'desktop', 'out', `MizTrace-${process.platform}-${process.arch}`);
const executable = process.argv[2] || (process.platform === 'win32' ? path.join(folder, 'MizTrace.exe') : path.join(folder, 'MizTrace.app', 'Contents', 'MacOS', 'MizTrace'));
if (!fs.existsSync(executable)) throw new Error(`请先打包，未找到：${executable}`);
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'miztrace-desktop-smoke-'));
const resultFile = path.join(data, 'result.json');
const cfg = structuredClone(DEFAULTS);
Object.assign(cfg, { roots: [data], setupDone: true, out: null,
  sessionDirs: Object.fromEntries(Object.keys(defaultSessionDirs()).map((id) => [id, [path.join(data, 'missing')]])),
  browser: { enabled: false }, shell: { enabled: false }, svn: { enabled: false }, fileScan: { enabled: false } });
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify(cfg));
const child = spawn(executable, [], { windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined,
  MIZTRACE_DATA_DIR: data, MIZTRACE_DESKTOP_SMOKE: '1', MIZTRACE_DESKTOP_SMOKE_OUTPUT: resultFile }, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', (d) => { output = (output + d).slice(-16000); });
child.stderr.on('data', (d) => { output = (output + d).slice(-16000); });
const timeout = setTimeout(() => child.kill(), 45_000);
try {
  const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  if (code !== 0 || !fs.existsSync(resultFile)) throw new Error(`桌面冒烟测试失败 (${code})\n${output}`);
  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  if (!result.ok || !result.sqlite || !result.saved || !result.updateDialog) throw new Error('桌面运行验证结果不完整');
  console.log('Desktop smoke passed:', JSON.stringify(result));
} finally { clearTimeout(timeout); }
