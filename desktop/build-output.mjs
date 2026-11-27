import fs from 'node:fs';

export function copyBuildOutput(source, destination) {
  // macOS Framework 内的相对链接必须随 App 一起移动，不能指回即将删除的临时目录。
  fs.cpSync(source, destination, { recursive: true, verbatimSymlinks: true });
}
