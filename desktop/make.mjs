/** Squirrel 的旧版资源工具不支持中文绝对路径：在临时目录制包，再复制成品。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { api } from '@electron-forge/core';
const desktop = path.dirname(fileURLToPath(import.meta.url));
const tempRoot = path.resolve(process.env.MIZTRACE_BUILD_TEMP_DIR || os.tmpdir());
if (process.platform === 'win32' && /[^\x00-\x7f]/.test(tempRoot)) throw new Error('Windows 安装器需要英文临时路径。请设置 MIZTRACE_BUILD_TEMP_DIR 为一个可写的英文路径后重试。');
fs.mkdirSync(tempRoot, { recursive: true });
const temp = fs.mkdtempSync(path.join(tempRoot, 'miztrace-make-'));
const tempOut = path.join(temp, 'out');
const output = path.join(desktop, 'out');
fs.cpSync(path.join(desktop, 'icons'), path.join(temp, 'icons'), { recursive: true });
process.env.MIZTRACE_BUILD_ICON_DIR = path.join(temp, 'icons');
try {
  await api.make({ dir: desktop, outDir: tempOut });
  if (path.dirname(path.resolve(output)) !== desktop || path.basename(output) !== 'out') throw new Error('输出目录校验失败');
  fs.rmSync(output, { recursive: true, force: true });
  fs.cpSync(tempOut, output, { recursive: true });
  console.log(`Installers built in ${output}`);
} finally {
  if (path.dirname(path.resolve(temp)) !== tempRoot || !path.basename(temp).startsWith('miztrace-make-')) throw new Error('临时目录校验失败');
  fs.rmSync(temp, { recursive: true, force: true });
}
