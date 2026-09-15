/**
 * WorkBuddy 桌面版会话适配器（腾讯 CodeBuddy 团队）。
 *
 * 会话位置：`<数据目录>/projects/<把 cwd 转义后的目录名>/<会话 uuid>.jsonl`
 *   Windows 在 `%APPDATA%\WorkBuddy` 或 `%LOCALAPPDATA%\WorkBuddy`，家目录下还有 `~/.workbuddy`。
 *   注意 `<数据目录>/sessions/*.json` 不是对话，是运行时的心跳状态（pid / startedAt / endpoint），不要读。
 *
 * 每行一个 JSON 对象，格式在实机上核实过（2026-09-15，5 个真实会话文件）：
 *   { type: 'message',  role: 'user' | 'assistant', content: [{type:'input_text'|'output_text'|'image_blob_ref', text}],
 *     sessionId, cwd, timestamp, id, parentId }
 *   { type: 'function_call',        name, arguments(JSON 字符串), callId, cwd, timestamp }
 *   { type: 'function_call_result', name, status, output, callId }
 *   { type: 'reasoning',            content, rawContent }        —— 思考过程，按项目规矩不读
 *   { type: 'file-history-snapshot' }                            —— 文件快照，不读
 *   { type: 'ai-title',             aiTitle }                    —— 人类可读的会话标题
 *
 * 因为是从真实文件反推的格式，这里跟 Claude Code 侧一样只取「改了什么」：
 * Edit / Write 这类写文件的工具记路径，Bash 记命令（优先用它给的 description），WebSearch 记搜索词；
 * Read / Grep 这些只读工具、以及 function_call_result 里的输出一律不记（会话不读工具输出）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { newSession, pushPrompt, pushReply, pushAction, finish, toIso, textOf, MAX_PROMPTS_PER_SESSION, MAX_ACTIONS_PER_SESSION } from './common.js';
import * as claudeCode from './claude-code.js';
import { makeGeneric } from './generic.js';

export const id = 'workbuddy';
/** 超过这个大小的会话文件不读，防止一个坏掉的文件拖垮整次采集。 */
const MAX_FILE_BYTES = 32 * 1024 * 1024;

/** 只有这些工具算「改了文件」；Read / Grep / ToolSearch 这类只读的忽略。 */
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export function detect(dirs) {
  return dirs.some((d) => fs.existsSync(d));
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 一次工具调用 → 证据动作。工具名与 Claude Code 同源，所以映射规则也保持一致。
 * @param {string} name
 * @param {string|object} rawArguments 实测是 JSON 字符串
 */
export function actionsFromCall(name, rawArguments) {
  const args = typeof rawArguments === 'string' ? safeJson(rawArguments) : rawArguments;
  if (!args || typeof args !== 'object') return [];
  const out = [];
  if (FILE_TOOLS.has(name)) {
    const fp = args.file_path ?? args.notebook_path;
    if (typeof fp === 'string' && fp) out.push({ kind: 'file', value: fp });
  } else if (name === 'Bash') {
    // description 是这次命令的一句话说明，比原始命令行更能说明「在干什么」
    const desc = args.description || args.command;
    if (typeof desc === 'string' && desc.trim()) out.push({ kind: 'command', value: desc.replace(/\s+/g, ' ').trim().slice(0, 80) });
  } else if (name === 'WebSearch') {
    const q = args.query;
    if (typeof q === 'string' && q.trim()) out.push({ kind: 'search', value: q.trim().slice(0, 80) });
  }
  return out;
}

/** 一行记录并入会话。导出以便单测。 */
export function ingest(s, rec, range, cutoffHour, opts = {}) {
  if (!rec || typeof rec !== 'object') return;
  if (typeof rec.sessionId === 'string' && rec.sessionId) {
    s.sessionId = rec.sessionId;
    s.threadId = rec.sessionId;
  }
  if (typeof rec.cwd === 'string' && path.isAbsolute(rec.cwd)) s.cwd = rec.cwd;

  if (rec.type === 'ai-title') {
    if (typeof rec.aiTitle === 'string' && rec.aiTitle.trim()) s.title = rec.aiTitle.trim();
    return;
  }

  const ts = toIso(rec.timestamp);
  if (!ts) return; // 没有时间的记录排不进时间板，不记

  switch (rec.type) {
    case 'message': {
      const text = textOf(rec.content);
      if (!text) return;
      if (rec.role === 'user') pushPrompt(s, text, ts, range, cutoffHour, opts);
      else if (rec.role === 'assistant') pushReply(s, text, ts, range, opts);
      return;
    }
    case 'function_call':
      for (const a of actionsFromCall(rec.name, rec.arguments)) pushAction(s, a.kind, a.value, ts, range);
      return;
    default:
      // reasoning（思考过程）、function_call_result（工具输出）、file-history-snapshot 都不读
      return;
  }
}

/**
 * 会话只在 `<数据目录>/projects` 下，同一个数据目录里的 sessions / logs / traces 都是运行时状态，
 * 不是对话 —— 那些目录里也有 jsonl，一旦被当成会话读进来就会污染日记。
 * 所以这里统一把范围收窄到 projects；用户把 sessionDirs.workbuddy 直接指到别处（没有 projects）时才用原目录。
 */
export function scopedDirs(dirs) {
  return dirs.map((d) => (fs.existsSync(path.join(d, 'projects')) ? path.join(d, 'projects') : d));
}

/** 找会话文件。范围见 scopedDirs。 */
export function listFiles(dirs, { maxDepth = 6, maxFiles = 2000 } = {}) {
  const files = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth || files.length >= maxFiles) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files.length >= maxFiles) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith('.jsonl')) files.push(p);
    }
  };
  for (const d of scopedDirs(dirs)) walk(d, 0);
  return files;
}

function collectNative(dirs, range, cutoffHour, opts = {}) {
  const wantReplies = opts.replies !== false;
  const sessions = [];
  for (const file of listFiles(dirs, { maxDepth: opts.maxDepth ?? 6, maxFiles: opts.maxFiles ?? 2000 })) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (stat.mtimeMs < Date.parse(range.startUtc) || stat.size > MAX_FILE_BYTES) continue;
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const s = newSession(id, path.basename(file, '.jsonl'), { file });
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue; // 坏行跳过，不让一行毁掉整个会话
      }
      ingest(s, rec, range, cutoffHour, { replies: wantReplies });
      if (s.prompts.length >= MAX_PROMPTS_PER_SESSION && s.actions.length >= MAX_ACTIONS_PER_SESSION) break;
    }
    if (s.prompts.length || s.actions.length) sessions.push(s);
  }
  return finish(sessions, cutoffHour);
}

/**
 * 先读 WorkBuddy 自己的格式；一个会话都认不出时，退回原来那两条路
 * （按 Claude Code 的 jsonl 认 → 再按通用格式尽力读），免得万一某个版本的格式变了就彻底读不到。
 * 退回时同样只在 projects 范围内找，不去碰 sessions / logs。
 */
export function collect(dirs, range, cutoffHour, opts = {}) {
  const native = collectNative(dirs, range, cutoffHour, opts);
  if (native.length) return native;
  const scoped = scopedDirs(dirs);
  const viaClaude = claudeCode.collect(scoped, range, cutoffHour, { ...opts, providerId: id, maxDepth: 6, maxFiles: 2000 });
  if (viaClaude.length) return viaClaude;
  return makeGeneric(id).collect(scoped, range, cutoffHour, opts);
}
