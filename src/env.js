/**
 * 运行环境闸门。
 *
 * 关键约束：`node:sqlite` 虽然在 Node 22.5.0 就加入了，但直到
 * **v23.4.0 与 v22.13.0** 才不再需要 `--experimental-sqlite`（Node 官方版本历史）。
 * 在 22.5–22.12 与 23.0–23.3 上直接 import 会抛 ERR_UNKNOWN_BUILTIN_MODULE，
 * 所以必须在 import 存储层之前先挡一道，给出人能看懂的提示而不是堆栈。
 *
 * 本文件不允许 import 任何可能失败的内置模块，它必须在最坏情况下也能加载。
 */

/** 免 flag 使用 node:sqlite 的最低版本要求。 */
export const NODE_REQUIREMENT = '>=22.13.0 <23.0.0 || >=23.4.0';

/** @param {string} version 形如 '22.13.0'（不含前缀 v） */
export function parseVersion(version) {
  const m = String(version).replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/**
 * 当前 Node 是否能免 flag 使用 node:sqlite。
 * @param {string} version
 * @returns {boolean}
 */
export function supportsBuiltinSqlite(version) {
  const v = parseVersion(version);
  if (!v) return false;
  if (v.major > 23) return true;
  if (v.major === 23) return v.minor >= 4;
  if (v.major === 22) return v.minor >= 13;
  return false;
}

/**
 * 不满足要求时返回给用户看的完整提示，满足时返回 null。
 * @param {string} version
 * @returns {string|null}
 */
export function nodeVersionProblem(version = process.versions.node) {
  if (supportsBuiltinSqlite(version)) return null;
  const v = parseVersion(version);
  const lines = [
    `miztrace 需要 Node ${NODE_REQUIREMENT}，当前是 v${version}。`,
    '',
    '原因：miztrace 用 Node 内置的 node:sqlite 存数据，不引入任何原生依赖。',
    '这个模块在 v22.5.0 加入，但直到 v22.13.0 / v23.4.0 才不再需要 --experimental-sqlite。',
  ];
  if (v && ((v.major === 22 && v.minor >= 5) || (v.major === 23 && v.minor < 4))) {
    lines.push('', '临时办法（不推荐长期用）：', `  node --experimental-sqlite ${process.argv[1] ?? 'bin/miztrace.js'} today`);
  }
  lines.push('', '建议升级到 Node 22 LTS 的最新版本，或 Node 24 及以上。');
  return lines.join('\n');
}
