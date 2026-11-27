import fs from 'node:fs';
import path from 'node:path';
import { journalError } from './journal-files.js';

const key = (p) => process.platform === 'win32' ? p.toLowerCase() : p;
export function normalizeLibraryRoots(roots) {
  if (!Array.isArray(roots) || roots.length > 32 || roots.some((p) => typeof p !== 'string' || !path.isAbsolute(p))) throw journalError('请选择最多 32 个有效目录');
  const canonical = roots.map((p) => {
    try {
      const real = fs.realpathSync(p);
      if (!fs.statSync(real).isDirectory()) throw new Error();
      fs.accessSync(real, fs.constants.R_OK);
      return real;
    } catch { throw journalError(`目录不存在或无法读取：${p}`); }
  });
  // 嵌套目录只扫描一次；Windows 的盘符和大小写不产生重复目录。
  return [...new Map(canonical.map((p) => [key(p), p])).values()]
    .filter((p, _, all) => !all.some((other) => key(p) !== key(other) && key(p).startsWith(key(other.endsWith(path.sep) ? other : other + path.sep))));
}

export function libraryRoots(cfg, warnings = []) {
  const roots = [];
  for (const p of cfg.journalLibrary?.roots ?? []) {
    try {
      // 使用保存时的真实路径，不自动跟随被替换成 junction 的根目录。
      if (key(fs.realpathSync(p)) !== key(p) || !fs.statSync(p).isDirectory()) throw new Error();
      roots.push(p);
    } catch { warnings.push(`日记库目录暂时不可用：${p}`); }
  }
  return roots;
}
