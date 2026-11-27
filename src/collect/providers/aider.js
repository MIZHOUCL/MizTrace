/**
 * aider 适配器。aider 不存全局会话，而是在每个项目目录里留两个文件：
 *   .aider.input.history   —— 每条提问带精确时间：`# 2025-09-10 08:03:12.345` 下面一行或几行 `+提问内容`
 *   .aider.chat.history.md —— 完整对话，只有会话开始时间（`# aider chat started at …`），提问以 `#### ` 开头
 * 提问从 input.history 取（有时间），回复从 chat.history 按顺序对上（时间用它前面那条提问的）。
 * 目录来自 --root：这个适配器的 dirs 就是扫描目录，在里面找带这两个文件的项目。
 */
import fs from 'node:fs';
import path from 'node:path';
import { newSession, pushPrompt, pushReply, finish, walkFiles } from './common.js';

export const id = 'aider';

export function detect(dirs) {
  return findProjects(dirs).length > 0;
}

export function findProjects(dirs) {
  const files = walkFiles(dirs, (n) => n === '.aider.input.history', { maxDepth: 4, maxFiles: 200 });
  return [...new Set(files.map((f) => path.dirname(f)))];
}

/** input.history → [{ts, text}]。本地时间，没有时区：按本机时区解释。 */
export function parseInputHistory(text) {
  const out = [];
  let cur = null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = line.match(/^# (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})(?:\.\d+)?\s*$/);
    if (m) {
      if (cur && cur.lines.length) out.push({ ts: cur.ts, text: cur.lines.join('\n') });
      const d = new Date(m[1].replace(' ', 'T'));
      cur = { ts: Number.isNaN(d.getTime()) ? null : d.toISOString(), lines: [] };
      continue;
    }
    if (cur && line.startsWith('+')) cur.lines.push(line.slice(1));
  }
  if (cur && cur.lines.length) out.push({ ts: cur.ts, text: cur.lines.join('\n') });
  return out.filter((p) => p.ts);
}

/** chat.history.md → 每条提问后面的助手文字，按顺序。 */
export function parseChatHistory(text) {
  const turns = [];
  let cur = null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (/^# aider chat started at /.test(line)) continue;
    if (line.startsWith('#### ')) {
      if (cur) turns.push(cur);
      cur = { prompt: line.slice(5), reply: [] };
      continue;
    }
    if (cur && !line.startsWith('> ')) cur.reply.push(line);
  }
  if (cur) turns.push(cur);
  return turns.map((t) => ({ prompt: t.prompt.trim(), reply: t.reply.join('\n').trim() || null }));
}

export function collect(dirs, range, cutoffHour, opts = {}) {
  const sessions = [];
  for (const dir of findProjects(dirs)) {
    let input;
    try {
      input = fs.readFileSync(path.join(dir, '.aider.input.history'), 'utf8');
    } catch {
      continue;
    }
    const prompts = parseInputHistory(input);
    let chat = [];
    try {
      chat = parseChatHistory(fs.readFileSync(path.join(dir, '.aider.chat.history.md'), 'utf8'));
    } catch {
      chat = [];
    }
    const replyOf = new Map();
    for (const t of chat) if (t.reply && !replyOf.has(t.prompt)) replyOf.set(t.prompt, t.reply);
    const s = newSession(id, `aider:${dir}`, { cwd: dir, file: path.join(dir, '.aider.input.history') });
    for (const p of prompts) {
      if (!pushPrompt(s, p.text, p.ts, range, cutoffHour, opts)) continue;
      const r = replyOf.get(p.text.split('\n')[0].trim());
      if (r) pushReply(s, r, p.ts, range, opts);
    }
    sessions.push(s);
  }
  return finish(sessions, cutoffHour);
}
