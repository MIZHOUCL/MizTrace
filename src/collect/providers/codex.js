/**
 * Codex CLI 会话适配器。
 * 读 ~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<thread_id>.jsonl 与 ~/.codex/archived_sessions/。
 *
 * 每行是 {timestamp, type, payload}；首行 type=session_meta，payload 带 id / cwd / git / cli_version。
 * 结构在实机上核实过（2026-09-03，2026-09-09 复核）：response_item.payload.type ∈
 * {message, reasoning, function_call, function_call_output, custom_tool_call, custom_tool_call_output,
 *  web_search_call, local_shell_call, ...}。
 * 用户输入同时出现在 response_item/message(role=user) 与 event_msg/user_message，只取前者以免重复计数。
 *
 * 工具调用有三代格式，都要认（2026-09-09 实机核实，新版只用第三种，旧解析器一条都抓不到）：
 *   1. function_call  name=exec_command  arguments='{"cmd":"…"}'；name=shell arguments='{"command":["bash","-lc","…"]}'
 *   2. custom_tool_call  name=apply_patch  input='*** Begin Patch…'
 *   3. custom_tool_call  name=exec  input='<一段 JS>'，里面是 tools.exec_command({...}) / tools.apply_patch("…")
 * 助手消息带 phase：commentary 是过程说明，final_answer 是这一轮的最终回复（ADR-022 记的就是它）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { inRange, localDateOf } from '../../time.js';
import { cleanReply, MAX_REPLY_CHARS } from './claude-code.js';

export const id = 'codex';
export const MAX_PROMPTS_PER_SESSION = 50;
export const MAX_ACTIONS_PER_SESSION = 200;
export { MAX_REPLY_CHARS };

export function detect(dirs) {
  return dirs.some((d) => fs.existsSync(d));
}

/**
 * Codex 会把环境上下文、用户指令等以 role=user 的形式注入首条消息，
 * 这些不是用户真正打的字，必须剔除，否则会话标题会变成 <environment_context>。
 */
const NOISE_PREFIX = [
  '<environment_context>',
  '<user_instructions>',
  '<system_context>',
  '<EXPERIMENTAL',
  '<vscode_context>',
  '<ide_context>',
  '# AGENTS.md',
  '# Files mentioned by the user',
  '## My request for Codex',
  '<in-app-browser-context',
  '<ambient-ui-state',
  '<turn_aborted',
  '<permissions',
];

export function cleanPrompt(text) {
  if (typeof text !== 'string') return null;
  const raw = text.trim();
  if (!raw) return null;
  if (NOISE_PREFIX.some((p) => raw.startsWith(p))) return null;
  // 整条内容就是一个 XML 块 => 注入内容
  if (/^<[a-z_]+>[\s\S]*<\/[a-z_]+>$/i.test(raw)) return null;
  const t = raw.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > 400 ? `${t.slice(0, 400)}…` : t;
}

/** message.content 是块数组，文本块的 type 形如 input_text / output_text。 */
export function extractPrompt(payload) {
  if (!payload || payload.role !== 'user') return null;
  const c = payload.content;
  if (typeof c === 'string') return cleanPrompt(c);
  if (!Array.isArray(c)) return null;
  const texts = c.filter((b) => b && typeof b.text === 'string' && String(b.type || '').endsWith('text')).map((b) => b.text);
  return texts.length ? cleanPrompt(texts.join('\n')) : null;
}

/** role=assistant 的 message → 回复文本（output_text 块）。 */
export function extractReply(payload) {
  if (!payload || payload.role !== 'assistant') return null;
  const c = payload.content;
  if (typeof c === 'string') return cleanReply(c);
  if (!Array.isArray(c)) return null;
  const texts = c.filter((b) => b && typeof b.text === 'string' && String(b.type || '').endsWith('text')).map((b) => b.text);
  return texts.length ? cleanReply(texts.join('\n')) : null;
}

/**
 * 从 apply_patch 的补丁文本里取出被改的文件路径。
 * 补丁可能是原文（真实换行），也可能嵌在一段 JS 的字符串字面量里（换行是两个字符 \n），两种都认。
 */
export function filesFromPatch(patch) {
  if (typeof patch !== 'string') return [];
  const out = [];
  const re = /\*\*\* (?:Add|Update|Delete) File: (.+?)(?=\\n|\\r|\r?\n|"|$)/gm;
  let m;
  while ((m = re.exec(patch)) !== null) {
    const f = m[1].trim();
    if (f && !out.includes(f)) out.push(f);
  }
  return out;
}

/** 从 src 的 start 位置（必须是 '{'）起，取出一个花括号配平的 JSON 对象文本；字符串里的括号不算。 */
export function jsonObjectAt(src, start) {
  if (src[start] !== '{') return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < src.length; i += 1) {
    const ch = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

/** 命令参数 → 一行命令文本：字符串原样；数组（bash -lc "…"）取最后一段。 */
function commandText(v) {
  const one = (s) => String(s).replace(/\s+/g, ' ').trim();
  if (typeof v === 'string') return one(v);
  if (Array.isArray(v) && v.length) {
    const parts = v.map((x) => String(x));
    const last = parts[parts.length - 1];
    // ["bash","-lc","实际命令"] → 实际命令
    if (parts.length >= 3 && /^-l?c$/.test(parts[parts.length - 2])) return one(last);
    return one(parts.join(' '));
  }
  return '';
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 第三代格式：一段 JS，里面调 tools.exec_command({...}) / tools.apply_patch(patch)。
 * 命令：找到 tools.exec_command( 后的第一个 JSON 对象，取 cmd；解析失败就退回正则抓 "cmd":"…"。
 * 文件：补丁一定含 "*** Update File: …"，直接在整段脚本里找，不管它是变量还是内联字面量。
 */
export function actionsFromScript(js) {
  const out = [];
  if (typeof js !== 'string' || !js) return out;
  const re = /tools\.(?:exec_command|shell|run_command)\s*\(\s*/g;
  let m;
  while ((m = re.exec(js)) !== null) {
    const at = m.index + m[0].length;
    let cmd = null;
    if (js[at] === '{') {
      const obj = jsonObjectAt(js, at);
      const parsed = obj ? safeJson(obj) : null;
      if (parsed) cmd = commandText(parsed.cmd ?? parsed.command);
      if (!cmd && obj) {
        const mm = obj.match(/"(?:cmd|command)"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        if (mm) cmd = safeJson(`"${mm[1]}"`) ?? mm[1];
      }
    } else if (js[at] === '"') {
      const mm = js.slice(at).match(/^"((?:[^"\\]|\\.)*)"/);
      if (mm) cmd = safeJson(`"${mm[1]}"`) ?? mm[1];
    }
    if (cmd) out.push({ kind: 'command', value: cmd.slice(0, 80) });
  }
  for (const f of filesFromPatch(js)) out.push({ kind: 'file', value: f });
  return out;
}

/** function_call / custom_tool_call / web_search_call / local_shell_call → 行为列表。 */
export function extractActions(payload) {
  const out = [];
  if (!payload) return out;
  if (payload.type === 'web_search_call') {
    const q = payload.action?.query;
    if (typeof q === 'string' && q.trim()) out.push({ kind: 'search', value: q.trim().slice(0, 80) });
    return out;
  }
  if (payload.type === 'local_shell_call') {
    const cmd = commandText(payload.action?.command);
    if (cmd) out.push({ kind: 'command', value: cmd.slice(0, 80) });
    return out;
  }
  const name = payload.name;
  if (!name) return out;
  const rawArgs = typeof payload.arguments === 'string' ? payload.arguments : null;
  const rawInput = typeof payload.input === 'string' ? payload.input : null;
  if (name === 'exec') {
    out.push(...actionsFromScript(rawInput ?? rawArgs ?? ''));
  } else if (name === 'exec_command' || name === 'shell' || name === 'shell_command' || name === 'container.exec' || name === 'local_shell') {
    const args = rawArgs ? safeJson(rawArgs) : null;
    const cmd = args ? commandText(args.cmd ?? args.command) : '';
    if (cmd) out.push({ kind: 'command', value: cmd.slice(0, 80) });
  } else if (name === 'apply_patch') {
    let text = rawInput ?? '';
    if (!text && rawArgs) {
      const args = safeJson(rawArgs);
      text = typeof args?.input === 'string' ? args.input : typeof args?.patch === 'string' ? args.patch : rawArgs;
    }
    for (const f of filesFromPatch(text)) out.push({ kind: 'file', value: f });
  } else if (name === 'web_search' || name === 'search') {
    const args = rawArgs ? safeJson(rawArgs) : null;
    const q = args?.query ?? args?.q;
    if (typeof q === 'string' && q.trim()) out.push({ kind: 'search', value: q.trim().slice(0, 80) });
  }
  return out;
}

function listFiles(dirs) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) files.push(p);
    }
  };
  for (const d of dirs) walk(d);
  return files;
}

/** 从文件名取 thread_id：rollout-<ISO>-<uuid>.jsonl */
export function threadIdFromName(file) {
  // resume 出来的会话文件名形如 rollout-<ISO>-<父线程 uuid>_<本会话 uuid>.jsonl，取最后一个
  const m = path.basename(file).match(/^rollout-\d{4}-\d{2}-\d{2}T[\d-]+-((?:[0-9a-f-]{36}_)*[0-9a-f-]{36})\.jsonl$/i);
  if (!m) return null;
  const parts = m[1].split('_');
  return parts[parts.length - 1];
}

/**
 * @param {string[]} dirs
 * @param {{startUtc:string,endUtc:string}} range
 * @param {number} cutoffHour
 * @param {{replies?:boolean}} [opts]
 */
export function collect(dirs, range, cutoffHour, opts = {}) {
  const wantReplies = opts.replies !== false;
  const start = Date.parse(range.startUtc);
  const out = [];

  for (const file of listFiles(dirs)) {
    try {
      if (fs.statSync(file).mtimeMs < start) continue;
    } catch {
      continue;
    }
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const session = newSession(file);
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      ingest(session, rec, range, cutoffHour, { replies: wantReplies });
    }
    if (wantReplies) flushReply(session, cutoffHour);
    delete session.pendingReply;
    delete session.lastPromptIndex;
    if (session.prompts.length || session.actions.length) out.push(session);
  }

  return out.sort((a, b) => String(a.firstTs).localeCompare(String(b.firstTs)));
}

function newSession(file) {
  return {
    providerId: id,
    sessionId: threadIdFromName(file) || path.basename(file, '.jsonl'),
    threadId: threadIdFromName(file),
    title: null,
    cwd: '.',
    gitBranch: null,
    firstTs: null,
    lastTs: null,
    prompts: [],
    actions: [],
    replies: [],
    schemaVersion: null,
    file,
    msgIndex: 0,
    seen: new Set(),
    pendingReply: null,
    lastPromptIndex: null,
  };
}

/** 把这一轮攒下的最终回复挂到上一条提问上。 */
export function flushReply(session, cutoffHour) {
  session.replies ??= [];
  if (!session.pendingReply || session.lastPromptIndex == null) {
    session.pendingReply = null;
    return;
  }
  if (session.replies.length < MAX_PROMPTS_PER_SESSION) {
    const r = session.pendingReply;
    session.replies.push({ index: r.index, text: r.text, ts: r.ts, promptIndex: session.lastPromptIndex, localDate: localDateOf(r.ts, cutoffHour) });
  }
  session.pendingReply = null;
}

/** 把一行记录并入会话。导出以便单测。 */
export function ingest(session, rec, range, cutoffHour, opts = {}) {
  const wantReplies = opts.replies !== false;
  const payload = rec.payload || {};

  if (rec.type === 'session_meta') {
    if (typeof payload.cwd === 'string' && payload.cwd) session.cwd = payload.cwd;
    if (payload.id) session.threadId = String(payload.id);
    if (payload.cli_version) session.schemaVersion = String(payload.cli_version);
    const branch = payload.git && typeof payload.git === 'object' ? payload.git.branch : null;
    if (typeof branch === 'string') session.gitBranch = branch;
    return;
  }
  // event_msg（含 user_message / task_complete）与 turn_context 一律跳过，避免与 response_item 重复计数
  if (rec.type !== 'response_item') return;
  if (!rec.timestamp || !inRange(rec.timestamp, range.startUtc, range.endUtc)) return;

  session.msgIndex += 1;
  if (!session.firstTs || rec.timestamp < session.firstTs) session.firstTs = rec.timestamp;
  if (!session.lastTs || rec.timestamp > session.lastTs) session.lastTs = rec.timestamp;

  if (payload.type === 'message') {
    if (payload.role === 'assistant') {
      if (!wantReplies) return;
      const text = extractReply(payload);
      if (!text) return;
      const isFinal = payload.phase === 'final_answer';
      // final_answer 一出现就定稿；没有 phase 的旧格式退回「这一轮最后一段」
      if (isFinal || !session.pendingReply?.final) session.pendingReply = { index: session.msgIndex, text, ts: rec.timestamp, final: isFinal };
      return;
    }
    const text = extractPrompt(payload);
    if (!text) return;
    if (wantReplies) flushReply(session, cutoffHour);
    if (session.prompts.length < MAX_PROMPTS_PER_SESSION) {
      session.prompts.push({ index: session.msgIndex, text, ts: rec.timestamp, localDate: localDateOf(rec.timestamp, cutoffHour) });
      session.lastPromptIndex = session.msgIndex;
      // 不给 Codex 会话伪造标题：它没有 ai-title 之类的正式标题字段，
      // 拿用户随便一句话当标题会让日志出现「那几行呢？」这种毫无信息量的条目。
    } else {
      session.lastPromptIndex = null;
    }
  } else if (payload.type === 'function_call' || payload.type === 'custom_tool_call' || payload.type === 'web_search_call' || payload.type === 'local_shell_call') {
    for (const a of extractActions(payload)) {
      if (session.actions.length >= MAX_ACTIONS_PER_SESSION) break;
      const key = `${a.kind}:${a.value}`;
      if (session.seen.has(key)) continue; // 同一文件被反复 patch 只记一次
      session.seen.add(key);
      session.actions.push({ ...a, index: session.msgIndex, ts: rec.timestamp });
    }
  }
}

/** 会话没有正式标题时，用首条输入的前 40 字当标题。 */
export function shortTitle(text) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t.length > 40 ? `${t.slice(0, 40)}…` : t;
}
