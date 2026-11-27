/**
 * 各适配器共用的小工具：会话对象、加提问 / 回复 / 动作、遍历文件、宽松解析时间。
 * 每个适配器只负责「从自己的格式里认出提问、回复、动作」，其余（上限、去重、排序、过滤空会话）都在这里。
 */
import fs from 'node:fs';
import path from 'node:path';
import { inRange, localDateOf } from '../../time.js';
import { cleanPrompt, cleanReply } from './claude-code.js';

export const MAX_PROMPTS_PER_SESSION = 50;
export const MAX_ACTIONS_PER_SESSION = 200;

export function newSession(providerId, sessionId, { cwd = '.', file = null, title = null, gitBranch = null, schemaVersion = null } = {}) {
  return { providerId, sessionId, threadId: sessionId, title, cwd: cwd || '.', gitBranch, firstTs: null, lastTs: null, prompts: [], actions: [], replies: [], schemaVersion, file, _n: 0, _seen: new Set(), _lastPrompt: null, _pending: null };
}

function touch(s, ts) {
  s._n += 1;
  if (!s.firstTs || ts < s.firstTs) s.firstTs = ts;
  if (!s.lastTs || ts > s.lastTs) s.lastTs = ts;
  return s._n;
}

/** 提问：新一轮开始，上一轮攒下的最终回复此刻定稿。 */
export function pushPrompt(s, text, ts, range, cutoffHour, opts = {}) {
  const t = cleanPrompt(text);
  if (!t || !ts || !inRange(ts, range.startUtc, range.endUtc)) return false;
  if (opts.replies !== false) flushReply(s, cutoffHour);
  const index = touch(s, ts);
  if (s.prompts.length >= MAX_PROMPTS_PER_SESSION) {
    s._lastPrompt = null;
    return false;
  }
  s.prompts.push({ index, text: t, ts, localDate: localDateOf(ts, cutoffHour) });
  s._lastPrompt = index;
  return true;
}

/** 回复：一轮里可能有好几段，只留最后一段。 */
export function pushReply(s, text, ts, range, opts = {}) {
  if (opts.replies === false) return;
  const t = cleanReply(text);
  if (!t || !ts || !inRange(ts, range.startUtc, range.endUtc)) return;
  const index = touch(s, ts);
  s._pending = { index, text: t, ts };
}

export function pushAction(s, kind, value, ts, range) {
  const v = String(value ?? '').trim();
  if (!v || !ts || !inRange(ts, range.startUtc, range.endUtc)) return;
  const key = `${kind}:${v}`;
  if (s._seen.has(key) || s.actions.length >= MAX_ACTIONS_PER_SESSION) return;
  s._seen.add(key);
  const index = touch(s, ts);
  s.actions.push({ index, kind, value: kind === 'command' ? v.slice(0, 200) : kind === 'search' ? v.slice(0, 80) : v, ts });
}

export function flushReply(s, cutoffHour) {
  if (s._pending && s._lastPrompt != null && s.replies.length < MAX_PROMPTS_PER_SESSION) {
    const r = s._pending;
    s.replies.push({ index: r.index, text: r.text, ts: r.ts, promptIndex: s._lastPrompt, localDate: localDateOf(r.ts, cutoffHour) });
  }
  s._pending = null;
}

/** 收尾：定稿最后一轮回复，去掉内部字段，丢掉空会话，按时间排。 */
export function finish(sessions, cutoffHour) {
  const out = [];
  for (const s of sessions) {
    if (!s) continue;
    flushReply(s, cutoffHour);
    delete s._n;
    delete s._seen;
    delete s._lastPrompt;
    delete s._pending;
    if (s.prompts.length || s.actions.length) out.push(s);
  }
  return out.sort((a, b) => String(a.firstTs).localeCompare(String(b.firstTs)));
}

/** 毫秒 / 秒 / ISO / Date → ISO；认不出返回 null。 */
export function toIso(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === 'number') {
    const ms = v < 1e11 ? v * 1000 : v; // 秒 vs 毫秒
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const s = String(v).trim();
  if (/^\d{9,13}(\.\d+)?$/.test(s)) return toIso(Number(s));
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 文件 mtime 早于窗口起点就不可能含范围内记录，整文件跳过。 */
export function touchedSince(file, sinceIso) {
  try {
    return fs.statSync(file).mtimeMs >= Date.parse(sinceIso);
  } catch {
    return false;
  }
}

/**
 * 遍历目录找文件。
 * @param {string[]} dirs
 * @param {(name:string, full:string)=>boolean} pred
 * @param {{maxDepth?:number, maxFiles?:number, skip?:Set<string>}} [opts]
 */
export function walkFiles(dirs, pred, opts = {}) {
  const { maxDepth = 6, maxFiles = 3000, skip = new Set(['node_modules', '.git']) } = opts;
  const out = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth || out.length >= maxFiles) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!skip.has(e.name)) walk(full, depth + 1);
      } else if (e.isFile() && pred(e.name, full)) out.push(full);
    }
  };
  for (const d of dirs) walk(d, 0);
  return out;
}

/**
 * 哪些 content 块算「用户看得见的正文」。
 * 除了 Anthropic 风格的 `text`，OpenAI 风格的 `input_text` / `output_text` 也是正文
 * —— WorkBuddy、Codex 都用这一套。2026-09-15 实测：只认 `type === 'text'` 会让
 * WorkBuddy 的会话整条读空（采集报告里 count 恒为 0），因为它每一条正文都是这两种类型。
 *
 * 这里刻意用白名单，而不是「type 以 text 结尾」：`reasoning_text` / `thinking_text`
 * 也会命中，那就违反了「会话不读思考过程」的承诺。要加新类型请单独确认过再往这里加。
 */
const TEXT_BLOCK_TYPES = new Set(['text', 'input_text', 'output_text']);

/** 一个 content 块是不是正文块：有 text 字段，且类型是已知的正文类型（没写类型也算）。 */
export function isTextBlock(block) {
  if (!block || typeof block !== 'object') return false;
  if (typeof block.text !== 'string') return false;
  return block.type == null || TEXT_BLOCK_TYPES.has(String(block.type));
}

/** 从一条消息的 content 里取纯文本：字符串直接用，数组只取正文块。 */
export function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content.map((b) => (typeof b === 'string' ? b : isTextBlock(b) ? b.text : null)).filter(Boolean);
    return parts.length ? parts.join('\n') : null;
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  return null;
}
