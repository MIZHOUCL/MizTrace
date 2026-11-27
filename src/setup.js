/**
 * 首次引导用的推荐：去哪里找痕迹。
 * 候选目录 = 常见的工作目录（存在的才算）+ 最近 AI 会话工作目录的父目录（一个人的项目基本都在同一两个父目录下）。
 * 只做存在性检查，不扫描内容。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recentSessionCwds } from './collect/sessions.js';

const COMMON_DIRS = ['Desktop', 'Documents', 'code', 'Code', 'projects', 'Projects', 'work', 'Work', 'dev', 'src', 'repos', 'workspace', 'Developer', 'GitHub', 'IdeaProjects', 'PycharmProjects', 'WebstormProjects', 'source/repos'];
const WIN_EXTRA = ['D:\\code', 'D:\\work', 'D:\\projects', 'D:\\project', 'D:\\dev', 'D:\\workspace', 'E:\\code', 'E:\\work', 'D:\\工作', 'D:\\项目'];

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 中文桌面 / 文档目录在 Windows 上仍叫 Desktop / Documents；macOS 的 ~/Documents 同理。 */
function homeDir(home, rel) {
  return path.join(home, ...rel.split('/'));
}

/**
 * @param {{home?:string, platform?:string, sessionDirs?:Record<string,string[]>, cwd?:string, roots?:string[]}} [opts]
 * @returns {{path:string, reason:string, sessions?:number}[]} 按推荐顺序
 */
export function candidateRoots(opts = {}) {
  const home = opts.home ?? os.homedir();
  const platform = opts.platform ?? process.platform;
  const seen = new Map();
  const add = (p, reason, weight, extra = {}) => {
    const resolved = path.resolve(p);
    if (resolved === path.resolve(home)) return; // 整个家目录太大，不推荐
    if (!isDir(resolved)) return;
    const cur = seen.get(resolved);
    if (!cur || cur.weight < weight) seen.set(resolved, { path: resolved, reason, weight, ...extra });
  };

  // 会话 cwd 的父目录：出现次数越多越靠前；cwd 本身直接就是仓库时，父目录才是要扫的范围
  if (opts.sessionDirs) {
    const parents = new Map();
    for (const { cwd } of recentSessionCwds(opts.sessionDirs, { limit: 80 })) {
      if (!path.isAbsolute(cwd)) continue;
      const parent = path.dirname(cwd);
      if (path.resolve(parent) === path.resolve(home) || parent === path.dirname(parent)) {
        parents.set(cwd, (parents.get(cwd) ?? 0) + 1); // 项目直接放在家目录 / 盘根下：推荐项目本身
      } else parents.set(parent, (parents.get(parent) ?? 0) + 1);
    }
    for (const [p, count] of [...parents.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
      add(p, `最近 ${count} 个 AI 会话在这里工作`, 100 + count, { sessions: count });
    }
  }
  for (const rel of COMMON_DIRS) add(homeDir(home, rel), '常见的工作目录', 10);
  if (platform === 'win32') for (const p of WIN_EXTRA) add(p, '常见的工作目录', 10);
  for (const r of opts.roots ?? []) add(r, '当前配置', 50);
  if (opts.cwd) add(opts.cwd, '启动 miztrace 的目录', 5);

  return [...seen.values()].sort((a, b) => b.weight - a.weight).map(({ weight, ...rest }) => rest);
}
