/**
 * Z Code（智谱）CLI 适配器。实测（2026-06 版）：~/.zcode/cli/rollout/model-io-sess_<sessionId>.jsonl
 * 是模型 I/O 日志，每行一次模型调用：
 *   { sessionId, turnId, startedAt, completedAt, request: { messages: [{ role, content }] }, response?: { text, toolCalls } }
 * 每次调用都带完整对话，所以同一条提问会在很多行里重复；按 turnId 归并：一轮取最早那行的最后一条
 * 真实 user 消息当提问（时间 = startedAt），取最后一行的 response.text 当回复（时间 = completedAt）。
 * 生成标题用的调用（system 以 "Generate a concise title" 开头）不算。
 * 会话目录：日志里没有 cwd，归到「.」由归因规则处理。
 */
import fs from 'node:fs';
import path from 'node:path';
import { newSession, pushPrompt, pushReply, pushAction, finish, toIso, walkFiles, touchedSince } from './common.js';

export const id = 'zcode';
const NOISE = ['<system-reminder>', '<environment_context>', '<user_instructions>'];

export function detect(dirs) {
  return dirs.some((d) => fs.existsSync(path.join(d, 'cli', 'rollout')));
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    const c = typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '';
    const t = c.trim();
    if (!t || NOISE.some((n) => t.startsWith(n))) continue;
    return t;
  }
  return null;
}

/** 一个 rollout 文件的文本 → 会话。导出给测试。 */
export function parseRollout(file, text, range, cutoffHour, opts = {}) {
  const turns = new Map(); // turnId → { prompt, promptTs, reply, replyTs, tools }
  let sessionId = null;
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const msgs = Array.isArray(rec?.request?.messages) ? rec.request.messages : [];
    if (!msgs.length) continue;
    const sys = msgs.find((m) => m?.role === 'system');
    if (typeof sys?.content === 'string' && /^Generate a concise title/i.test(sys.content)) continue;
    sessionId ??= typeof rec.sessionId === 'string' ? rec.sessionId : null;
    const turnId = typeof rec.turnId === 'string' ? rec.turnId : `line:${turns.size}`;
    const startedAt = toIso(rec.startedAt);
    const t = turns.get(turnId) ?? { prompt: null, promptTs: null, reply: null, replyTs: null, tools: [] };
    if (!t.prompt) {
      t.prompt = lastUserText(msgs);
      t.promptTs = startedAt;
    }
    const resp = rec.response;
    if (typeof resp?.text === 'string' && resp.text.trim()) {
      t.reply = resp.text;
      t.replyTs = toIso(rec.completedAt) ?? startedAt;
    }
    for (const c of Array.isArray(resp?.toolCalls) ? resp.toolCalls : []) {
      const name = String(c?.toolName ?? c?.name ?? '').toLowerCase();
      const args = c?.args ?? c?.input ?? {};
      if (/bash|shell|exec/.test(name) && typeof args.command === 'string') t.tools.push({ kind: 'command', value: args.command, ts: startedAt });
      else if (/edit|write|patch/.test(name) && typeof (args.file_path ?? args.path) === 'string') t.tools.push({ kind: 'file', value: args.file_path ?? args.path, ts: startedAt });
    }
    turns.set(turnId, t);
  }
  if (!turns.size) return null;
  const sid = sessionId ?? path.basename(file, '.jsonl').replace(/^model-io-/, '');
  const s = newSession(id, sid, { cwd: '.', file });
  for (const t of turns.values()) {
    if (t.prompt) pushPrompt(s, t.prompt, t.promptTs, range, cutoffHour, opts);
    for (const a of t.tools) pushAction(s, a.kind, a.value, a.ts, range);
    if (t.reply) pushReply(s, t.reply, t.replyTs, range, opts);
  }
  return s;
}

export function collect(dirs, range, cutoffHour, opts = {}) {
  const sessions = [];
  const files = walkFiles(dirs.map((d) => path.join(d, 'cli', 'rollout')), (n) => /^model-io-.*\.jsonl$/.test(n), { maxDepth: 1 });
  for (const file of files) {
    if (!touchedSince(file, range.startUtc)) continue;
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const s = parseRollout(file, text, range, cutoffHour, opts);
    if (s) sessions.push(s);
  }
  return finish(sessions, cutoffHour);
}
