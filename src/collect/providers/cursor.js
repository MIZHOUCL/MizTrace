/**
 * Cursor 适配器。对话存在 VS Code 风格的 SQLite 里：
 *   <globalStorage>/state.vscdb 的 cursorDiskKV 表：
 *     composerData:<composerId> → { composerId, name, createdAt, lastUpdatedAt, fullConversationHeadersOnly: [{ bubbleId, type }] }
 *     bubbleId:<composerId>:<bubbleId> → { type: 1(用户)|2(助手), text, createdAt? }
 *   <workspaceStorage>/<hash>/workspace.json → { folder: 'file:///…' }，同目录 state.vscdb 的 ItemTable
 *     key 'composer.composerData' → { allComposers: [{ composerId, … }] }，用它把会话归到工作区目录。
 * 复制到临时目录再读（Cursor 运行中会锁库），和浏览器历史一个路子。格式随版本变，读不到就降级、不猜。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { newSession, pushPrompt, pushReply, finish, toIso } from './common.js';

export const id = 'cursor';

export function detect(dirs) {
  return dirs.some((d) => fs.existsSync(path.join(d, 'globalStorage', 'state.vscdb')));
}

function withCopy(file, fn) {
  const tmp = path.join(os.tmpdir(), `miztrace-cursor-${crypto.randomBytes(6).toString('hex')}.db`);
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

/** composerId → 工作区目录。 */
export function workspaceMap(userDir) {
  const out = new Map();
  const wsRoot = path.join(userDir, 'workspaceStorage');
  let entries = [];
  try {
    entries = fs.readdirSync(wsRoot, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(wsRoot, e.name);
    let folder = null;
    try {
      const w = JSON.parse(fs.readFileSync(path.join(dir, 'workspace.json'), 'utf8'));
      if (typeof w.folder === 'string') folder = decodeURIComponent(w.folder.replace(/^file:\/\/\/?/, (m) => (process.platform === 'win32' ? '' : '/'))).replace(/^\/([A-Za-z]:)/, '$1');
    } catch {
      folder = null;
    }
    const db = path.join(dir, 'state.vscdb');
    if (!folder || !fs.existsSync(db)) continue;
    try {
      withCopy(db, (d) => {
        const row = d.prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'").get();
        const j = row ? JSON.parse(row.value) : null;
        for (const c of Array.isArray(j?.allComposers) ? j.allComposers : []) if (typeof c?.composerId === 'string') out.set(c.composerId, folder);
      });
    } catch {
      /* 这个工作区读不了就算了 */
    }
  }
  return out;
}

export function collect(dirs, range, cutoffHour, opts = {}) {
  const sessions = [];
  const start = Date.parse(range.startUtc);
  const end = Date.parse(range.endUtc);
  for (const userDir of dirs) {
    const file = path.join(userDir, 'globalStorage', 'state.vscdb');
    if (!fs.existsSync(file)) continue;
    const wsOf = workspaceMap(userDir);
    withCopy(file, (db) => {
      const rows = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'").all();
      for (const r of rows) {
        let c;
        try {
          c = JSON.parse(r.value);
        } catch {
          continue;
        }
        const updated = Number(c?.lastUpdatedAt ?? c?.createdAt ?? 0);
        const created = Number(c?.createdAt ?? 0);
        if (!(updated >= start && created < end)) continue;
        const cid = c.composerId ?? r.key.slice('composerData:'.length);
        const s = newSession(id, cid, { cwd: wsOf.get(cid) ?? '.', title: typeof c.name === 'string' && c.name.trim() ? c.name.trim() : null, file });
        const heads = Array.isArray(c.fullConversationHeadersOnly) ? c.fullConversationHeadersOnly : [];
        let lastTs = toIso(created);
        for (const h of heads) {
          const row = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(`bubbleId:${cid}:${h.bubbleId}`);
          if (!row) continue;
          let b;
          try {
            b = JSON.parse(row.value);
          } catch {
            continue;
          }
          const ts = toIso(b?.createdAt) ?? lastTs;
          lastTs = ts;
          if (b?.type === 1) pushPrompt(s, b.text, ts, range, cutoffHour, opts);
          else if (b?.type === 2) pushReply(s, b.text, ts, range, opts);
        }
        sessions.push(s);
      }
    });
  }
  return finish(sessions, cutoffHour);
}
