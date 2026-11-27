/**
 * Claude Code 会话适配器。
 * 读 ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl，每行一条记录。
 *
 * 解析与过滤规则整套借鉴 temosy/devlog 的 src/transcript.rs（MIT），
 * 逐条说明见规划文档 PRIOR_ART.md §3.1，归属见 THIRD_PARTY_NOTICES.md。
 *
 * 除了用户提问与工具调用，还记每一轮的**最终回复**（ADR-022）：一轮 = 一条真实提问到下一条真实提问之间，
 * 助手最后一段 text 就是它对这轮工作的交代。只记这一段、截前 300 字，中间的思考与工具输出一概不读。
 */
import fs from 'node:fs';
import path from 'node:path';
import { inRange, localDateOf } from '../../time.js';

export const id = 'claude-code';
export const MAX_PROMPTS_PER_SESSION = 50;
export const MAX_ACTIONS_PER_SESSION = 200;
export const MAX_REPLY_CHARS = 300;

/** 这些子目录是 workflow / 子 agent 的转录，不是用户会话。 */
const NOT_USER_SESSIONS = ['/subagents/', '/workflows/', '\\subagents\\', '\\workflows\\'];

/** 只从这些工具调用里取「改了什么」。 */
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** harness 注入的内容，不算用户输入。 */
const NOISE_PREFIX = ['<command-name>', '<command-message>', '<local-command', '<system-reminder>', 'Caveat:', '<user-prompt-submit-hook>', '<ci-monitor-event', '<task-notification'];

export function detect(dirs) {
  return dirs.some((d) => fs.existsSync(d));
}

export function cleanPrompt(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (!t) return null;
  if (NOISE_PREFIX.some((p) => t.startsWith(p))) return null;
  const collapsed = t.replace(/\s+/g, ' ');
  return collapsed.length > 400 ? `${collapsed.slice(0, 400)}…` : collapsed;
}

/**
 * 助手回复压成一句话：代码块整块换成 [代码]，Markdown 标记去掉，空白折叠，截断。
 * 两个适配器共用（codex.js 也 import 这里）。
 */
/** 这些不是回复，是 harness 的状态文本（限流、被打断、没有要求回复），不能当成「模型做了什么」。 */
const NOISE_REPLY = [/^API Error\b/i, /^No response requested\.?$/i, /^\[?Request interrupted/i, /^Request timed out/i, /^\(no content\)$/i, /^Error:/];

export function cleanReply(text, max = MAX_REPLY_CHARS) {
  if (typeof text !== 'string') return null;
  if (NOISE_REPLY.some((re) => re.test(text.trim()))) return null;
  const t = text
    .replace(/```[\s\S]*?```/g, ' [代码] ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** message.content 允许是字符串，或数组（只取 type:'text' 块）。 */
export function extractPrompt(message) {
  if (!message) return null;
  const c = message.content;
  if (typeof c === 'string') return cleanPrompt(c);
  if (!Array.isArray(c)) return null;
  const texts = c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text);
  return texts.length ? cleanPrompt(texts.join('\n')) : null;
}

/** 助手消息里的 text 块（thinking / tool_use 不算）。 */
export function extractReply(message) {
  if (!message) return null;
  const c = message.content;
  if (typeof c === 'string') return cleanReply(c);
  if (!Array.isArray(c)) return null;
  const texts = c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text);
  return texts.length ? cleanReply(texts.join('\n')) : null;
}

/** 只看 tool_use 块；Read/Grep 这类只读工具忽略。 */
export function extractActions(message) {
  const out = [];
  const c = message?.content;
  if (!Array.isArray(c)) return out;
  for (const b of c) {
    if (!b || b.type !== 'tool_use') continue;
    if (FILE_TOOLS.has(b.name)) {
      const fp = b.input?.file_path ?? b.input?.notebook_path;
      if (typeof fp === 'string' && fp) out.push({ kind: 'file', value: fp });
    } else if (b.name === 'Bash') {
      const desc = b.input?.description || b.input?.command;
      if (typeof desc === 'string' && desc.trim()) out.push({ kind: 'command', value: desc.replace(/\s+/g, ' ').trim().slice(0, 80) });
    } else if (b.name === 'WebSearch') {
      const q = b.input?.query;
      if (typeof q === 'string' && q) out.push({ kind: 'search', value: q.slice(0, 80) });
    }
  }
  return out;
}

function listFiles(dirs, { maxDepth = Infinity, maxFiles = Infinity } = {}) {
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
      else if (e.name.endsWith('.jsonl') && !NOT_USER_SESSIONS.some((s) => p.includes(s))) files.push(p);
    }
  };
  for (const d of dirs) walk(d, 0);
  return files;
}

/** 把这一轮攒下的最后一段助手回复挂到上一条提问上。 */
function flushReply(s, cutoffHour) {
  if (!s.pendingReply || s.lastPromptIndex == null) {
    s.pendingReply = null;
    return;
  }
  if (s.replies.length < MAX_PROMPTS_PER_SESSION) {
    const r = s.pendingReply;
    s.replies.push({ index: r.index, text: r.text, ts: r.ts, promptIndex: s.lastPromptIndex, localDate: localDateOf(r.ts, cutoffHour) });
  }
  s.pendingReply = null;
}

/**
 * @param {string[]} dirs
 * @param {{startUtc:string,endUtc:string}} range
 * @param {number} cutoffHour
 * @param {{replies?:boolean, providerId?:string, maxDepth?:number, maxFiles?:number}} [opts]
 *   providerId / maxDepth / maxFiles 给照着 Claude Code 做的工具（CodeBuddy 系）复用这套解析时用；自己的目录不限
 * @returns {import('../sessions.js').SessionActivity[]}
 */
export function collect(dirs, range, cutoffHour, opts = {}) {
  const wantReplies = opts.replies !== false;
  const providerId = opts.providerId ?? id;
  const start = Date.parse(range.startUtc);
  /** @type {Map<string, any>} */
  const acc = new Map();

  for (const file of listFiles(dirs, { maxDepth: opts.maxDepth, maxFiles: opts.maxFiles })) {
    // 文件 mtime 早于窗口起点 => 不可能含范围内记录，整文件跳过。
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
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue; // 坏行跳过，不中断整次扫描
      }
      const sid = rec.sessionId;
      if (!sid) continue;

      // ai-title 单独处理：取标题，且故意不受时间窗口限制。
      if (rec.type === 'ai-title') {
        const s = acc.get(sid);
        if (s && typeof rec.aiTitle === 'string' && rec.aiTitle.trim()) s.title = rec.aiTitle.trim();
        continue;
      }
      if (rec.type === 'custom-title') {
        const s = acc.get(sid);
        if (s && typeof rec.customTitle === 'string' && rec.customTitle.trim()) s.title = rec.customTitle.trim();
        continue;
      }
      if (rec.type !== 'user' && rec.type !== 'assistant') continue;
      if (rec.isSidechain === true) continue; // 子 agent 转录，工作已在主链出现
      if (!rec.timestamp || !inRange(rec.timestamp, range.startUtc, range.endUtc)) continue;

      let s = acc.get(sid);
      if (!s) {
        s = {
          providerId,
          sessionId: sid,
          threadId: sid,
          title: null,
          cwd: typeof rec.cwd === 'string' && rec.cwd ? rec.cwd : '.',
          gitBranch: typeof rec.gitBranch === 'string' ? rec.gitBranch : null,
          firstTs: rec.timestamp,
          lastTs: rec.timestamp,
          prompts: [],
          actions: [],
          replies: [],
          schemaVersion: rec.version ? String(rec.version) : null,
          file,
          msgIndex: 0,
          seen: new Set(),
          pendingReply: null,
          lastPromptIndex: null,
        };
        acc.set(sid, s);
      }
      s.msgIndex += 1;
      if (rec.timestamp < s.firstTs) s.firstTs = rec.timestamp;
      if (rec.timestamp > s.lastTs) s.lastTs = rec.timestamp;

      if (rec.type === 'user') {
        const text = extractPrompt(rec.message);
        if (text) {
          // 新一轮开始：上一轮的最终回复此刻定稿
          if (wantReplies) flushReply(s, cutoffHour);
          if (s.prompts.length < MAX_PROMPTS_PER_SESSION) {
            s.prompts.push({ index: s.msgIndex, text, ts: rec.timestamp, localDate: localDateOf(rec.timestamp, cutoffHour) });
            s.lastPromptIndex = s.msgIndex;
          } else {
            s.lastPromptIndex = null; // 提问已经截断，后面的回复也不要
          }
        }
      } else {
        for (const a of extractActions(rec.message)) {
          if (s.actions.length >= MAX_ACTIONS_PER_SESSION) break;
          const key = `${a.kind}:${a.value}`;
          if (s.seen.has(key)) continue; // 同一文件被反复编辑只记一次
          s.seen.add(key);
          s.actions.push({ ...a, index: s.msgIndex, ts: rec.timestamp });
        }
        if (wantReplies) {
          const reply = extractReply(rec.message);
          // 一轮里可能有好几段 text（"我先看看…" → 工具 → "改好了…"），只留最后一段
          if (reply) s.pendingReply = { index: s.msgIndex, text: reply, ts: rec.timestamp };
        }
      }
    }
  }

  const sessions = [...acc.values()];
  for (const s of sessions) {
    if (wantReplies) flushReply(s, cutoffHour);
    delete s.pendingReply;
    delete s.lastPromptIndex;
  }
  return sessions.filter((s) => s.prompts.length > 0 || s.actions.length > 0).sort((a, b) => a.firstTs.localeCompare(b.firstTs));
}
