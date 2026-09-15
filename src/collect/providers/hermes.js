/**
 * Hermes Agent（Nous Research 的开源 agent）适配器。
 * 状态目录 ~/.hermes/。**没有拿到样例文件**，按公开资料里的形状尽力读，两条路：
 *   1. ~/.hermes/state.db（SQLite）：sessions 表 + messages 表（role / content / 时间列名不确定，逐个候选试）
 *   2. 目录里其它 JSON / JSONL（sessions/、logs/ 之类）交给通用适配器
 * 认不出就什么都不记；读到的一律标「通用格式」。拿到样例后换成专用解析。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { newSession, pushPrompt, pushReply, pushAction, finish, toIso, textOf } from './common.js';
import { makeGeneric } from './generic.js';

export const id = 'hermes';

export function detect(dirs) {
  return dirs.some((d) => fs.existsSync(d));
}

const ROLE_COLS = ['role', 'sender', 'author', 'type'];
const TEXT_COLS = ['content', 'text', 'message', 'body'];
const TS_COLS = ['timestamp', 'created_at', 'createdAt', 'ts', 'time', 'created'];
const SID_COLS = ['session_id', 'sessionId', 'session', 'conversation_id', 'thread_id'];
const CWD_COLS = ['cwd', 'working_dir', 'workdir', 'directory', 'project_path'];
const TITLE_COLS = ['title', 'name', 'summary'];

function pick(row, cols) {
  for (const c of cols) if (row[c] != null && row[c] !== '') return row[c];
  return null;
}

/** 内容列可能是纯文本，也可能是 JSON（数组块 / {text} / 带 tool_calls）。 */
function parseContent(v) {
  if (typeof v !== 'string') return { text: textOf(v), actions: [] };
  const t = v.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return { text: v, actions: [] };
  try {
    const j = JSON.parse(t);
    const actions = [];
    for (const call of Array.isArray(j?.tool_calls) ? j.tool_calls : []) {
      const name = String(call?.function?.name ?? call?.name ?? '').toLowerCase();
      let args = call?.function?.arguments ?? call?.arguments ?? call?.input ?? {};
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args);
        } catch {
          args = {};
        }
      }
      if (/terminal|bash|shell|execute|command/.test(name) && typeof (args.command ?? args.cmd) === 'string') actions.push({ kind: 'command', value: args.command ?? args.cmd });
      else if (/write|edit|patch|create_file/.test(name) && typeof (args.path ?? args.file_path ?? args.filename) === 'string') actions.push({ kind: 'file', value: args.path ?? args.file_path ?? args.filename });
      else if (/search|browse|fetch/.test(name) && typeof (args.query ?? args.url) === 'string') actions.push({ kind: 'search', value: args.query ?? args.url });
    }
    return { text: textOf(j?.content ?? j?.text ?? j) ?? null, actions };
  } catch {
    return { text: v, actions: [] };
  }
}

function withCopy(file, fn) {
  const tmp = path.join(os.tmpdir(), `miztrace-hermes-${crypto.randomBytes(6).toString('hex')}.db`);
  try {
    fs.copyFileSync(file, tmp);
    const db = new DatabaseSync(tmp, { readOnly: true });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 忽略 */
    }
  }
}

/** 从一份 SQLite 里读会话。表名 / 列名不确定，全部按候选试；导出给测试。 */
export function readStateDb(file, range, cutoffHour, opts = {}) {
  return withCopy(file, (db) => {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    const msgTable = ['messages', 'message', 'chat_messages', 'events'].find((t) => tables.has(t));
    if (!msgTable) return [];
    const cols = db.prepare(`PRAGMA table_info(${msgTable})`).all().map((c) => c.name);
    const sidCol = SID_COLS.find((c) => cols.includes(c));
    const tsCol = TS_COLS.find((c) => cols.includes(c));
    if (!sidCol || !tsCol) return [];
    const sessTable = ['sessions', 'session', 'conversations'].find((t) => tables.has(t));
    const meta = new Map();
    if (sessTable) {
      for (const r of db.prepare(`SELECT * FROM ${sessTable}`).all()) {
        const sid = r.id ?? r.session_id ?? r.sessionId;
        if (sid != null) meta.set(String(sid), { cwd: pick(r, CWD_COLS), title: pick(r, TITLE_COLS) });
      }
    }
    const start = Date.parse(range.startUtc);
    const rows = db.prepare(`SELECT * FROM ${msgTable} ORDER BY ${tsCol}`).all();
    const sessions = new Map();
    for (const r of rows) {
      const ts = toIso(r[tsCol]);
      if (!ts || Date.parse(ts) < start - 24 * 3600_000) continue;
      const sid = String(r[sidCol]);
      if (!sessions.has(sid)) {
        const m = meta.get(sid) ?? {};
        sessions.set(sid, newSession(id, sid, { cwd: m.cwd ?? '.', file, title: m.title ? String(m.title).trim().slice(0, 120) : null }));
      }
      const s = sessions.get(sid);
      const role = String(pick(r, ROLE_COLS) ?? '').toLowerCase();
      const { text, actions } = parseContent(pick(r, TEXT_COLS));
      if (role === 'user' || role === 'human') pushPrompt(s, text, ts, range, cutoffHour, opts);
      else if (role === 'assistant' || role === 'ai' || role === 'model') {
        for (const a of actions) pushAction(s, a.kind, a.value, ts, range);
        pushReply(s, text, ts, range, opts);
      }
    }
    return [...sessions.values()];
  });
}

export function collect(dirs, range, cutoffHour, opts = {}) {
  const sessions = [];
  const seenDb = [];
  for (const d of dirs) {
    for (const name of ['state.db', 'hermes.db', 'sessions.db']) {
      const file = path.join(d, name);
      if (!fs.existsSync(file)) continue;
      seenDb.push(file);
      try {
        sessions.push(...readStateDb(file, range, cutoffHour, opts));
      } catch {
        /* 库锁着或形状不对：退到通用格式 */
      }
    }
  }
  const fromDb = finish(sessions, cutoffHour);
  if (fromDb.length) return fromDb;
  // 没有库或库里认不出：目录里的 JSON / JSONL 按通用格式尽力读
  return makeGeneric(id).collect(dirs, range, cutoffHour, opts);
}
