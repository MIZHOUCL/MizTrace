/**
 * 会话适配器注册与调度（PROJECT_PLAN §6 的 AgentSessionProvider 契约）。
 *
 * 约束：
 * - 只读白名单目录；
 * - schema 未知时降级为 link_only，绝不猜测内容；
 * - 任一适配器失败不影响其他来源。
 *
 * 两类适配器：
 * - 专用：拿到过样例、按真实格式解析（Claude Code、Codex、Gemini CLI、Qwen Code、opencode、Cursor、Cline 系、aider）；
 * - 通用（generic: true）：只知道目录、没拿到样例的工具，按「role + 文本 + 时间」的通用形状尽力读（见 providers/generic.js）。
 *   读到的会标「通用格式」；拿到样例后换成专用适配器。
 *
 * @typedef {Object} SessionActivity
 * @property {string} providerId
 * @property {string} sessionId
 * @property {string|null} threadId
 * @property {string|null} title
 * @property {string} cwd
 * @property {string|null} gitBranch
 * @property {string|null} firstTs
 * @property {string|null} lastTs
 * @property {{index:number,text:string,ts:string,localDate:string}[]} prompts
 * @property {{index:number,kind:string,value:string,ts:string}[]} actions
 * @property {{index:number,text:string,ts:string,promptIndex:number,localDate:string}[]} replies 每轮的最终回复，promptIndex 指向它答的那条提问
 * @property {string|null} schemaVersion
 * @property {string} file
 */
import fs from 'node:fs';
import path from 'node:path';
import * as claudeCode from './providers/claude-code.js';
import * as codex from './providers/codex.js';
import * as geminiCli from './providers/gemini-cli.js';
import * as qwenCode from './providers/qwen-code.js';
import * as opencode from './providers/opencode.js';
import * as cursor from './providers/cursor.js';
import * as cline from './providers/cline.js';
import * as aider from './providers/aider.js';
import * as zcode from './providers/zcode.js';
import * as hermes from './providers/hermes.js';
import * as vscodeChat from './providers/vscode-chat.js';
import * as workbuddy from './providers/workbuddy.js';
import { makeGeneric } from './providers/generic.js';

/** Cline 的两个分支：同一格式、不同插件目录。 */
const rooCode = { id: 'roo-code', detect: cline.detect, collect: (dirs, range, cutoff, opts) => cline.collect(dirs, range, cutoff, { ...opts, providerId: 'roo-code' }) };
const kiloCode = { id: 'kilo-code', detect: cline.detect, collect: (dirs, range, cutoff, opts) => cline.collect(dirs, range, cutoff, { ...opts, providerId: 'kilo-code' }) };
/** VS Code 系：同一套 chatSessions 格式，不同的 User 目录。 */
const vsc = (pid) => ({ id: pid, detect: vscodeChat.detect, collect: (dirs, range, cutoff, opts) => vscodeChat.collect(dirs, range, cutoff, { ...opts, providerId: pid }) });
/** iFlow CLI 是 Gemini CLI 的分支，格式相同。 */
const iflow = { id: 'iflow', detect: geminiCli.detect, collect: (dirs, range, cutoff, opts) => geminiCli.collect(dirs, range, cutoff, { ...opts, providerId: 'iflow' }) };
/**
 * CodeBuddy Code 是照着 Claude Code 做的 CLI（官网在 codebuddy.cn/work）。
 * 这个还没拿到样例：先按 Claude Code 的 jsonl 格式读（sessionId + type + timestamp + message），
 * 一个会话都认不出再退回通用格式。读到的仍标「通用格式」—— 没核对过真实文件就不能说「专用」。
 * 目录遍历限深度和数量：桌面应用的数据目录可能很大。
 *
 * WorkBuddy（同团队的桌面版）原本也走这条路。2026-09-15 拿到 5 个真实会话文件后发现它用的是自己的格式
 * （type:'message' + role + content[input_text/output_text]，另配 function_call / ai-title），
 * 走通用格式会因为认不出 input_text 而一条都读不到，所以单独拆成 providers/workbuddy.js 专用适配器。
 */
const claudeLike = (pid) => ({
  id: pid,
  detect: (dirs) => dirs.some((d) => fs.existsSync(d)),
  collect(dirs, range, cutoff, opts = {}) {
    const found = claudeCode.collect(dirs, range, cutoff, { ...opts, providerId: pid, maxDepth: 6, maxFiles: 2000 });
    return found.length ? found : makeGeneric(pid).collect(dirs, range, cutoff, opts);
  },
});

/** 注册表：顺序就是展示顺序。usesRoots 的适配器（aider）在项目目录里找文件，dirs 传扫描目录。 */
export const PROVIDERS = [
  { id: 'claude-code', name: 'Claude Code', mod: claudeCode },
  { id: 'codex', name: 'Codex', mod: codex },
  { id: 'gemini-cli', name: 'Gemini CLI', mod: geminiCli },
  { id: 'qwen-code', name: 'Qwen Code', mod: qwenCode },
  { id: 'iflow', name: 'iFlow CLI', mod: iflow },
  { id: 'opencode', name: 'opencode', mod: opencode },
  { id: 'cursor', name: 'Cursor', mod: cursor },
  { id: 'cline', name: 'Cline', mod: cline },
  { id: 'roo-code', name: 'Roo Code', mod: rooCode },
  { id: 'kilo-code', name: 'Kilo Code', mod: kiloCode },
  { id: 'aider', name: 'aider', mod: aider, usesRoots: true },
  { id: 'zcode', name: 'Z Code', mod: zcode },
  { id: 'copilot-chat', name: 'VS Code Copilot Chat', mod: vsc('copilot-chat') },
  // 以下只拿到目录、没拿到会话样例：VS Code 系的按 chatSessions 读，其余目录按通用格式尽力读
  { id: 'antigravity', name: 'Antigravity', mod: vsc('antigravity'), generic: true },
  { id: 'trae', name: 'Trae', mod: vsc('trae'), generic: true },
  { id: 'windsurf', name: 'Windsurf', mod: vsc('windsurf'), generic: true },
  { id: 'kimi-code', name: 'Kimi Code', mod: makeGeneric('kimi-code'), generic: true },
  { id: 'deepseek', name: 'DeepSeek', mod: makeGeneric('deepseek'), generic: true },
  { id: 'grok-build', name: 'Grok Build', mod: makeGeneric('grok-build'), generic: true },
  { id: 'copilot-cli', name: 'Copilot CLI', mod: makeGeneric('copilot-cli'), generic: true },
  { id: 'codebuddy', name: 'CodeBuddy', mod: claudeLike('codebuddy'), generic: true },
  { id: 'workbuddy', name: 'WorkBuddy', mod: workbuddy },
  { id: 'hermes', name: 'Hermes Agent', mod: hermes, generic: true },
  { id: 'goose', name: 'Goose', mod: makeGeneric('goose'), generic: true },
  { id: 'crush', name: 'Crush', mod: makeGeneric('crush'), generic: true },
];
export const PROVIDER_NAMES = Object.fromEntries(PROVIDERS.map((p) => [p.id, p.name]));

function dirsFor(p, sessionDirs, roots) {
  if (p.usesRoots) return roots ?? [];
  return sessionDirs?.[p.id] ?? [];
}

/**
 * 跑所有可用的适配器。
 * @param {Record<string,string[]>} sessionDirs provider id -> 目录列表
 * @param {{startUtc:string,endUtc:string}} range
 * @param {number} cutoffHour
 * @param {{replies?:boolean, roots?:string[]}} [opts] replies=false 时不记助手回复；roots 给在项目目录里找文件的适配器
 * @returns {{sessions:SessionActivity[], report:{id:string,name:string,status:string,count:number,generic?:boolean,error?:string}[]}}
 */
export function collectSessions(sessionDirs, range, cutoffHour, opts = {}) {
  const sessions = [];
  const report = [];
  for (const p of PROVIDERS) {
    const dirs = dirsFor(p, sessionDirs, opts.roots);
    const base = { id: p.id, name: p.name, ...(p.generic ? { generic: true } : {}) };
    if (!dirs.length || !p.mod.detect(dirs)) {
      report.push({ ...base, status: 'absent', count: 0 });
      continue;
    }
    try {
      const found = p.mod.collect(dirs, range, cutoffHour, { replies: opts.replies });
      for (const s of found) s.replies ??= [];
      sessions.push(...found);
      report.push({ ...base, status: 'ok', count: found.length });
    } catch (err) {
      // 单个适配器失败降级，不影响其他来源
      report.push({ ...base, status: 'link_only', count: 0, error: err.message });
    }
  }
  return { sessions, report };
}

/** 哪些适配器的目录存在（网页引导用，不解析内容）。 */
export function detectProviders(sessionDirs, roots = []) {
  return PROVIDERS.map((p) => {
    const dirs = dirsFor(p, sessionDirs, roots);
    const existing = dirs.filter((d) => fs.existsSync(d));
    const found = existing.length > 0 && (p.usesRoots ? p.mod.detect(existing) : true);
    return { id: p.id, name: p.name, found, dirs: found ? existing : [], generic: p.generic === true };
  });
}

/**
 * 最近会话的工作目录：只读每个文件的开头几 KB 取 cwd，用来给「扫描目录」推荐候选。
 * 一个人的项目基本都在同一两个父目录下（~/code、D:\work），会话 cwd 的父目录就是最好的 root 候选。
 * 只看 Claude Code / Codex 的 jsonl：其它工具的目录结构不同，靠会话里的 cwd 归因即可。
 * @returns {{cwd:string, mtimeMs:number}[]} 按最近修改排序
 */
export function recentSessionCwds(sessionDirs, { limit = 80 } = {}) {
  const files = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'subagents' || e.name === 'workflows') continue;
        walk(p, depth + 1);
      } else if (e.name.endsWith('.jsonl')) {
        try {
          files.push({ file: p, mtimeMs: fs.statSync(p).mtimeMs });
        } catch {
          /* 跳过 */
        }
      }
    }
  };
  for (const id of ['claude-code', 'codex']) for (const d of sessionDirs?.[id] ?? []) walk(d, 0);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const out = [];
  for (const f of files.slice(0, limit)) {
    let head;
    try {
      const fd = fs.openSync(f.file, 'r');
      try {
        const buf = Buffer.alloc(16 * 1024);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        head = buf.toString('utf8', 0, n);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      continue;
    }
    // 两种格式的 cwd 都长得像 "cwd":"/path"，不必完整解析每一行
    const m = head.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)+)"/);
    if (!m) continue;
    let cwd;
    try {
      cwd = JSON.parse(`"${m[1]}"`);
    } catch {
      continue;
    }
    if (cwd && cwd !== '.') out.push({ cwd, mtimeMs: f.mtimeMs });
  }
  return out;
}
