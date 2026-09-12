/**
 * 通用适配器：给那些**没有拿到样例文件**的工具用 —— Kimi Code、DeepSeek 的编码工具、Z Code、Grok Build、
 * Antigravity、Windsurf、Copilot CLI、Trae……它们大多也把对话存成 JSON / JSONL，
 * 消息里总有 role / type 说明是谁说的、content / text 是内容、timestamp / ts / time 是时间。
 *
 * 这不是猜格式：认不出 role + 文本 + 时间三样齐全的记录就什么都不记；认出来的按「通用格式」标出来，
 * 让用户知道这是尽力而为。拿到样例后应该换成专用适配器（见 ADR-023）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { newSession, pushPrompt, pushReply, finish, toIso, walkFiles, touchedSince, textOf } from './common.js';

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const USER = new Set(['user', 'human']);
const ASSISTANT = new Set(['assistant', 'model', 'ai', 'gemini', 'bot']);
const TS_KEYS = ['timestamp', 'ts', 'time', 'created_at', 'createdAt', 'created', 'date'];
const CWD_KEYS = ['cwd', 'working_dir', 'workingDir', 'workspace', 'workspacePath', 'projectPath', 'project_path', 'directory', 'root', 'rootPath', 'workdir'];

function roleOf(o) {
  const r = String(o?.role ?? o?.type ?? o?.author ?? o?.sender ?? '').toLowerCase();
  if (USER.has(r)) return 'user';
  if (ASSISTANT.has(r)) return 'assistant';
  return null;
}

function tsOf(o, fallback) {
  for (const k of TS_KEYS) {
    const v = o?.[k];
    const iso = toIso(typeof v === 'object' && v ? (v.created ?? v.start ?? null) : v);
    if (iso) return iso;
  }
  return fallback;
}

function textIn(o) {
  return textOf(o?.content) ?? textOf(o?.text) ?? textOf(o?.message?.content) ?? textOf(o?.message) ?? textOf(o?.parts) ?? null;
}

/** 从任意 JSON 值里摊出所有「像消息」的对象（带 role 与文本）。深度有限，防循环与巨型对象。 */
export function messagesIn(value, depth = 0, out = [], ctx = { cwd: null }) {
  if (depth > 6 || !value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const v of value) messagesIn(v, depth + 1, out, ctx);
    return out;
  }
  for (const k of CWD_KEYS) if (!ctx.cwd && typeof value[k] === 'string' && path.isAbsolute(value[k])) ctx.cwd = value[k];
  const role = roleOf(value);
  const text = role ? textIn(value) : null;
  if (role && typeof text === 'string' && text.trim()) {
    out.push({ role, text, raw: value });
    return out; // 消息内部不再往下找，避免把 content 数组里的块当成消息
  }
  for (const v of Object.values(value)) if (v && typeof v === 'object') messagesIn(v, depth + 1, out, ctx);
  return out;
}

/** 一个文件 → 一个会话（文件就是会话的边界）。导出给测试。 */
export function parseFile(file, text, range, cutoffHour, opts = {}, providerId = 'generic') {
  const ctx = { cwd: null };
  let msgs = [];
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  const looksWhole = (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'));
  if (looksWhole && !trimmed.includes('\n{')) {
    try {
      msgs = messagesIn(JSON.parse(trimmed), 0, [], ctx);
    } catch {
      msgs = [];
    }
  }
  if (!msgs.length) {
    for (const line of trimmed.split('\n')) {
      const l = line.trim();
      if (!l.startsWith('{')) continue;
      try {
        messagesIn(JSON.parse(l), 0, msgs, ctx);
      } catch {
        /* 坏行跳过 */
      }
    }
  }
  if (!msgs.length) return null;
  let mtime = null;
  try {
    mtime = new Date(fs.statSync(file).mtimeMs).toISOString();
  } catch {
    mtime = null;
  }
  const s = newSession(providerId, `${providerId}:${path.basename(file)}`, { cwd: ctx.cwd ?? '.', file });
  let last = null;
  for (const m of msgs) {
    const ts = tsOf(m.raw, last);
    if (!ts) continue; // 没有时间的记录排不进时间板，不记
    last = ts;
    if (m.role === 'user') pushPrompt(s, m.text, ts, range, cutoffHour, opts);
    else pushReply(s, m.text, ts, range, opts);
  }
  if (!s.prompts.length && mtime && msgs.some((m) => m.role === 'user')) {
    // 整个文件都没有时间戳：只有当文件本身是今天改的，才把提问按文件时间记下（总比丢掉强，但标为同一时刻）
    for (const m of msgs) if (m.role === 'user') pushPrompt(s, m.text, mtime, range, cutoffHour, opts);
  }
  return s;
}

/** 造一个通用适配器：id 与目录由注册表给。 */
export function makeGeneric(providerId) {
  return {
    id: providerId,
    generic: true,
    detect: (dirs) => dirs.some((d) => fs.existsSync(d)),
    collect(dirs, range, cutoffHour, opts = {}) {
      const sessions = [];
      const files = walkFiles(dirs, (n) => /\.(json|jsonl|ndjson)$/i.test(n), { maxDepth: 6, maxFiles: 2000 });
      for (const file of files) {
        if (!touchedSince(file, range.startUtc)) continue;
        let st;
        try {
          st = fs.statSync(file);
        } catch {
          continue;
        }
        if (st.size > MAX_FILE_BYTES) continue;
        let text;
        try {
          text = fs.readFileSync(file, 'utf8');
        } catch {
          continue;
        }
        const s = parseFile(file, text, range, cutoffHour, opts, providerId);
        if (s) sessions.push(s);
      }
      return finish(sessions, cutoffHour);
    },
  };
}
