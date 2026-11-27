/**
 * opencode（sst/opencode）会话适配器。
 * 存储是一堆 JSON 文件：~/.local/share/opencode/storage/
 *   session/<projectID>/<sessionID>.json  { id, projectID, directory, title, time: { created, updated } }
 *   message/<sessionID>/<messageID>.json  { id, sessionID, role: 'user'|'assistant', time: { created, completed } }
 *   part/<messageID>/<partID>.json        { id, messageID, sessionID, type: 'text'|'tool'|..., text?, tool?, state?: { input } }
 * 时间是毫秒。只读 time.updated 落在窗口内的会话，避免把几百个旧会话的 part 全读一遍。
 *
 * 新版 opencode 把这些搬进了 SQLite：<数据目录>/opencode.db，session / message / part 三张表，
 * 每行一个 data 列存原来那份 JSON（列名按候选试，没拿到样例）。两种都读，谁有读谁；装了新版的用户之前一个会话都读不到，就是这个原因。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { newSession, pushPrompt, pushReply, pushAction, finish, toIso, readJson, walkFiles } from './common.js';

export const id = 'opencode';

const DB_NAMES = ['opencode.db', 'db.sqlite', 'storage.db'];

function dbFileIn(d) {
  for (const n of DB_NAMES) {
    const f = path.join(d, n);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

export function detect(dirs) {
  return dirs.some((d) => fs.existsSync(path.join(d, 'storage', 'session')) || fs.existsSync(path.join(d, 'session')) || dbFileIn(d));
}

function withCopy(file, fn) {
  const tmp = path.join(os.tmpdir(), `miztrace-opencode-${crypto.randomBytes(6).toString('hex')}.db`);
  try {
    fs.copyFileSync(file, tmp);
    for (const suffix of ['-wal', '-shm']) if (fs.existsSync(file + suffix)) fs.copyFileSync(file + suffix, tmp + suffix);
    const db = new DatabaseSync(tmp, { readOnly: true });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  } finally {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.rmSync(tmp + suffix, { force: true });
      } catch {
        /* 忽略 */
      }
    }
  }
}

/** 一行 → 对象：有 data / json 列就解析它并与其余列合并，没有就用列本身。 */
function rowObj(r) {
  for (const c of ['data', 'json', 'value', 'content']) {
    if (typeof r[c] === 'string' && r[c].trim().startsWith('{')) {
      try {
        return { ...r, ...JSON.parse(r[c]) };
      } catch {
        /* 不是 JSON 就用列 */
      }
    }
  }
  return r;
}

const num = (v) => (v == null ? 0 : Number(v) || 0);

/** SQLite 版：session / message / part 三张表。导出给测试。 */
export function readDb(file, range, cutoffHour, opts = {}) {
  const start = Date.parse(range.startUtc);
  const end = Date.parse(range.endUtc);
  return withCopy(file, (db) => {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    const sessT = ['session', 'sessions'].find((t) => tables.has(t));
    const msgT = ['message', 'messages'].find((t) => tables.has(t));
    const partT = ['part', 'parts'].find((t) => tables.has(t));
    if (!sessT || !msgT) return [];
    const colsOf = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    const msgCols = colsOf(msgT);
    const partCols = partT ? colsOf(partT) : [];
    const msgSidCol = ['session_id', 'sessionID', 'sessionId', 'session'].find((c) => msgCols.includes(c));
    const partMidCol = ['message_id', 'messageID', 'messageId', 'message'].find((c) => partCols.includes(c));
    if (!msgSidCol) return [];
    const sessions = [];
    for (const raw of db.prepare(`SELECT * FROM ${sessT}`).all()) {
      const meta = rowObj(raw);
      const sid = String(meta.id ?? raw.id ?? '');
      if (!sid) continue;
      const created = num(meta.time?.created ?? meta.time_created ?? meta.created_at ?? meta.created);
      const updated = num(meta.time?.updated ?? meta.time_updated ?? meta.updated_at ?? meta.updated) || created;
      const inWin = (t) => t >= start && t < end;
      if (!inWin(updated) && !inWin(created) && !(created < start && updated >= end)) continue;
      const s = newSession(id, sid, { cwd: typeof meta.directory === 'string' ? meta.directory : typeof meta.cwd === 'string' ? meta.cwd : '.', file, title: typeof meta.title === 'string' ? meta.title.trim() || null : null });
      const msgs = db.prepare(`SELECT * FROM ${msgT} WHERE ${msgSidCol} = ?`).all(sid).map(rowObj).sort((a, b) => num(a.time?.created ?? a.time_created ?? a.created_at) - num(b.time?.created ?? b.time_created ?? b.created_at));
      for (const m of msgs) {
        const mid = String(m.id ?? '');
        const ts = toIso(num(m.time?.created ?? m.time_created ?? m.created_at));
        const parts = partT && partMidCol ? db.prepare(`SELECT * FROM ${partT} WHERE ${partMidCol} = ?`).all(mid).map(rowObj).sort((a, b) => String(a.id).localeCompare(String(b.id))) : [];
        const { text, actions } = fromParts(parts);
        if (m.role === 'user') pushPrompt(s, text, ts, range, cutoffHour, opts);
        else if (m.role === 'assistant') {
          for (const a of actions) pushAction(s, a.kind, a.value, ts, range);
          pushReply(s, text, toIso(num(m.time?.completed ?? m.time_completed)) ?? ts, range, opts);
        }
      }
      sessions.push(s);
    }
    return sessions;
  });
}

function storageRoot(d) {
  return fs.existsSync(path.join(d, 'storage', 'session')) ? path.join(d, 'storage') : d;
}

const FILE_TOOLS = new Set(['edit', 'write', 'patch', 'multiedit']);
const SHELL_TOOLS = new Set(['bash', 'shell']);
const SEARCH_TOOLS = new Set(['websearch', 'web_search', 'webfetch']);

/** 一个消息的所有 part → 文本与动作。导出给测试。 */
export function fromParts(parts) {
  const texts = [];
  const actions = [];
  for (const p of parts) {
    if (!p || typeof p !== 'object') continue;
    if (p.type === 'text' && typeof p.text === 'string') texts.push(p.text);
    else if (p.type === 'tool') {
      const tool = String(p.tool ?? '').toLowerCase();
      const input = p.state?.input ?? p.input ?? {};
      if (FILE_TOOLS.has(tool) && typeof input.filePath === 'string') actions.push({ kind: 'file', value: input.filePath });
      else if (SHELL_TOOLS.has(tool) && typeof input.command === 'string') actions.push({ kind: 'command', value: input.command });
      else if (SEARCH_TOOLS.has(tool) && typeof (input.query ?? input.url) === 'string') actions.push({ kind: 'search', value: input.query ?? input.url });
    }
  }
  return { text: texts.length ? texts.join('\n') : null, actions };
}

export function collect(dirs, range, cutoffHour, opts = {}) {
  const sessions = [];
  const start = Date.parse(range.startUtc);
  const end = Date.parse(range.endUtc);
  for (const d of dirs) {
    const dbFile = dbFileIn(d);
    if (dbFile) {
      try {
        sessions.push(...readDb(dbFile, range, cutoffHour, opts));
      } catch {
        /* 库形状不对或锁着：继续看 JSON 目录 */
      }
    }
    const root = storageRoot(d);
    const sessionFiles = walkFiles([path.join(root, 'session')], (n) => n.endsWith('.json'), { maxDepth: 3 });
    for (const file of sessionFiles) {
      const meta = readJson(file);
      if (!meta || typeof meta.id !== 'string') continue;
      const updated = Number(meta.time?.updated ?? meta.time?.created ?? 0);
      if (!(updated >= start && updated < end)) {
        // 会话最后一次更新不在窗口内：要么全在之前，要么全在之后（跨日界的会话会在 created 落窗时被读到）
        const created = Number(meta.time?.created ?? 0);
        if (!(created >= start && created < end) && !(created < start && updated >= end)) continue;
      }
      const s = newSession(id, meta.id, { cwd: typeof meta.directory === 'string' ? meta.directory : '.', file, title: typeof meta.title === 'string' ? meta.title.trim() || null : null });
      const msgDir = path.join(root, 'message', meta.id);
      const msgs = walkFiles([msgDir], (n) => n.endsWith('.json'), { maxDepth: 1 })
        .map((f) => readJson(f))
        .filter((m) => m && typeof m.id === 'string')
        .sort((a, b) => Number(a.time?.created ?? 0) - Number(b.time?.created ?? 0));
      for (const m of msgs) {
        const ts = toIso(m.time?.created);
        const parts = walkFiles([path.join(root, 'part', m.id)], (n) => n.endsWith('.json'), { maxDepth: 1 })
          .map((f) => readJson(f))
          .filter(Boolean)
          .sort((a, b) => String(a.id).localeCompare(String(b.id)));
        const { text, actions } = fromParts(parts);
        if (m.role === 'user') pushPrompt(s, text, ts, range, cutoffHour, opts);
        else if (m.role === 'assistant') {
          for (const a of actions) pushAction(s, a.kind, a.value, ts, range);
          pushReply(s, text, toIso(m.time?.completed) ?? ts, range, opts);
        }
      }
      sessions.push(s);
    }
  }
  return finish(sessions, cutoffHour);
}
