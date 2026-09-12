/**
 * VS Code 系「聊天会话」适配器：VS Code（Copilot Chat）、以及基于 VS Code 的 Antigravity IDE、Trae、Windsurf。
 * VS Code 把聊天会话存成 <User>/workspaceStorage/<hash>/chatSessions/<sessionId>.json：
 *   { version, sessionId, creationDate, requests: [{ message: { text }, response: [{ value }…], timestamp }] }
 * 同目录 workspace.json 的 folder 是工作区路径。
 * 传进来的目录若不是 <User> 目录（没有 workspaceStorage），就按通用格式尽力读（Antigravity 自己的 conversations 目录等）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { newSession, pushPrompt, pushReply, finish, toIso, readJson, walkFiles, touchedSince } from './common.js';
import { makeGeneric } from './generic.js';

export const id = 'vscode-chat';

export function detect(dirs) {
  return dirs.some((d) => fs.existsSync(d));
}

export function folderOf(wsDir) {
  const w = readJson(path.join(wsDir, 'workspace.json'));
  const f = typeof w?.folder === 'string' ? w.folder : typeof w?.workspace === 'string' ? w.workspace : null;
  if (!f) return null;
  try {
    const u = new URL(f);
    let p = decodeURIComponent(u.pathname);
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1).replace(/\//g, '\\');
    return p;
  } catch {
    return f;
  }
}

function responseText(response) {
  if (typeof response === 'string') return response;
  if (!Array.isArray(response)) return null;
  const parts = [];
  for (const r of response) {
    if (typeof r === 'string') parts.push(r);
    else if (typeof r?.value === 'string') parts.push(r.value);
    else if (typeof r?.text === 'string') parts.push(r.text);
  }
  return parts.length ? parts.join('\n') : null;
}

/** 一个 chatSessions 文件 → 会话。导出给测试。 */
export function parseChatSession(file, json, range, cutoffHour, opts = {}, providerId = id, cwd = '.') {
  if (!json || !Array.isArray(json.requests)) return null;
  const sid = typeof json.sessionId === 'string' ? json.sessionId : path.basename(file, '.json');
  const s = newSession(providerId, sid, { cwd, file, title: typeof json.customTitle === 'string' ? json.customTitle : null });
  let last = toIso(json.creationDate);
  for (const r of json.requests) {
    const ts = toIso(r?.timestamp) ?? last;
    if (!ts) continue;
    last = ts;
    const text = typeof r?.message?.text === 'string' ? r.message.text : typeof r?.message === 'string' ? r.message : null;
    pushPrompt(s, text, ts, range, cutoffHour, opts);
    pushReply(s, responseText(r?.response), ts, range, opts);
  }
  return s;
}

export function collect(dirs, range, cutoffHour, opts = {}) {
  const providerId = opts.providerId ?? id;
  const sessions = [];
  const generic = makeGeneric(providerId);
  for (const d of dirs) {
    const wsRoot = path.join(d, 'workspaceStorage');
    if (!fs.existsSync(wsRoot)) {
      sessions.push(...generic.collect([d], range, cutoffHour, opts));
      continue;
    }
    const files = walkFiles([wsRoot], (n, full) => n.endsWith('.json') && path.basename(path.dirname(full)) === 'chatSessions', { maxDepth: 3, maxFiles: 2000 });
    for (const file of files) {
      if (!touchedSince(file, range.startUtc)) continue;
      const wsDir = path.dirname(path.dirname(file));
      const s = parseChatSession(file, readJson(file), range, cutoffHour, opts, providerId, folderOf(wsDir) ?? '.');
      if (s) sessions.push(s);
    }
  }
  return finish(sessions, cutoffHour);
}
