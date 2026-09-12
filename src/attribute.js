/**
 * 项目归因（PROJECT_PLAN §6）。
 * 优先级：会话 cwd / gitBranch → git 仓库根 → 用户 glob 规则（用户规则最终优先）。
 */
import path from 'node:path';

/** 由路径生成稳定的项目 id。 */
export function projectIdOf(rootPath) {
  return slug(displayName(rootPath));
}

/**
 * 项目显示名。basename 太短或纯数字时带上父目录，避免出现名叫「20」的项目。
 * 过长的目录名（例如以 URL 命名的目录）截断。
 */
export function displayName(rootPath) {
  const resolved = path.resolve(rootPath);
  const base = path.basename(resolved) || 'unknown';
  const parent = path.basename(path.dirname(resolved));
  const needsParent = base.length <= 2 || /^\d+$/.test(base);
  const name = needsParent && parent ? `${parent}/${base}` : base;
  return name.length > 40 ? `${name.slice(0, 40)}…` : name;
}

function slug(name) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9一-龥._/-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'unknown'
  );
}

/**
 * 建立项目表：仓库根 + 会话 cwd。
 * @param {string[]} repos
 * @param {import('./collect/sessions.js').SessionActivity[]} sessions
 * @param {{rules?:{match:string,project:string}[]}} [opts] 用户规则，match 为路径子串
 */
export function buildProjects(repos, sessions, opts = {}) {
  /** @type {Map<string,{id:string,name:string,rootPath:string}>} */
  const byRoot = new Map();
  const add = (rootPath) => {
    const resolved = path.resolve(rootPath);
    if (byRoot.has(resolved)) return byRoot.get(resolved);
    const entry = { id: projectIdOf(resolved), name: displayName(resolved), rootPath: resolved };
    byRoot.set(resolved, entry);
    return entry;
  };
  for (const r of repos) add(r);
  // 会话 cwd 若不在已知仓库内，自己也算一个项目
  for (const s of sessions) {
    if (!s.cwd || s.cwd === '.') continue;
    const owner = repoContaining(s.cwd, [...byRoot.keys()]);
    if (!owner) add(s.cwd);
  }
  // 文件系统扫描发现的目录（不在任何仓库内）同样算项目
  for (const d of opts.extraDirs ?? []) {
    if (!repoContaining(d, [...byRoot.keys()])) add(d);
  }
  const projects = dedupeIds([...byRoot.values()]);
  // 用户规则最后应用，覆盖自动结果
  for (const rule of opts.rules ?? []) {
    for (const p of projects) {
      if (p.rootPath.includes(rule.match)) {
        p.name = rule.project;
        p.id = projectIdOf(rule.project);
        p.userRenamed = true;
      }
    }
  }
  return projects;
}

/**
 * 消除 id 冲突。
 *
 * 实测过的 bug：`D:\...\WXWork\Global` 与 `D:\software\postgreSQL\data\global`
 * 都被 slug 成 `global`，`nt_db` 在两个账号目录下各有一个 —— 结果渲染时
 * 同一份事实被打印了两遍，输出里出现重复的 [[global]] / [[Global]] / [[nt_db]]。
 * 冲突时用父目录消歧，仍冲突就加序号，保证 id 与目录一一对应。
 */
export function dedupeIds(entries) {
  const byId = new Map();
  for (const e of entries) {
    if (!byId.has(e.id)) byId.set(e.id, []);
    byId.get(e.id).push(e);
  }
  const taken = new Set();
  const out = [];
  for (const [id, group] of byId) {
    if (group.length === 1) {
      group[0].id = uniqueId(id, taken);
      out.push(group[0]);
      continue;
    }
    for (const e of group) {
      const parent = path.basename(path.dirname(path.resolve(e.rootPath)));
      const withParent = parent ? `${parent}/${path.basename(path.resolve(e.rootPath))}` : e.name;
      e.name = withParent.length > 40 ? `${withParent.slice(0, 40)}…` : withParent;
      e.id = uniqueId(slug(e.name), taken);
      out.push(e);
    }
  }
  return out;
}

function uniqueId(base, taken) {
  let id = base || 'unknown';
  let n = 2;
  while (taken.has(id)) {
    id = `${base}-${n}`;
    n += 1;
  }
  taken.add(id);
  return id;
}

/**
 * 路径 → 项目 id 的解析器。
 * dedupeIds 可能改过 id，所以其他模块必须走这里而不是自己再算一次 slug，
 * 否则证据会挂到一个不存在的项目上。
 * @param {{id:string, rootPath:string}[]} projects
 */
export function makeResolver(projects) {
  const roots = projects
    .map((p) => ({ root: path.resolve(p.rootPath), id: p.id }))
    .sort((a, b) => b.root.length - a.root.length); // 最长前缀优先
  return function resolve(somePath) {
    if (!somePath) return null;
    const target = path.resolve(somePath);
    for (const r of roots) {
      if (target === r.root || target.startsWith(`${r.root}${path.sep}`)) return r.id;
    }
    return null;
  };
}

/** 找出包含 somePath 的最长仓库根。 */
export function repoContaining(somePath, roots) {
  const target = path.resolve(somePath);
  let best = null;
  for (const r of roots) {
    const root = path.resolve(r);
    if (target === root || target.startsWith(`${root}${path.sep}`)) {
      if (!best || root.length > best.length) best = root;
    }
  }
  return best;
}

/** 把一条会话归到项目 id。 */
export function attributeSession(session, projects) {
  const roots = projects.map((p) => p.rootPath);
  const owner = repoContaining(session.cwd ?? '.', roots);
  if (owner) return projects.find((p) => path.resolve(p.rootPath) === owner)?.id ?? null;
  return null;
}
