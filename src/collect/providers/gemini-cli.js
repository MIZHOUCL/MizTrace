/**
 * Gemini CLI（以及它的分支 Qwen Code）会话适配器。
 * 会话存在 ~/.gemini/tmp/<项目哈希>/chats/session-<时间>-<id>.json：
 *   { sessionId, projectHash, startTime, lastUpdated, messages: [{ id, timestamp, type: 'user'|'gemini', content, toolCalls?: [{ name, args }] }] }
 * 项目哈希 → 目录：~/.gemini/projects.json 里有 { projects: { "<路径>": "<哈希或名字>" } }，反查得到 cwd。
 * 旧的 checkpoint-*.json 不带时间戳，不读。
 */
import fs from 'node:fs';
import path from 'node:path';
import { newSession, pushPrompt, pushReply, pushAction, finish, toIso, readJson, touchedSince, walkFiles, textOf } from './common.js';

export const id = 'gemini-cli';

export function detect(dirs) {
  return dirs.some((d) => fs.existsSync(d));
}

/** 哈希 → 项目路径。projects.json 不存在或格式不对就空。 */
export function projectMap(homeDir) {
  const j = readJson(path.join(homeDir, 'projects.json'));
  const out = new Map();
  const projects = j?.projects && typeof j.projects === 'object' ? j.projects : {};
  for (const [p, h] of Object.entries(projects)) if (typeof h === 'string') out.set(h, p);
  return out;
}

const FILE_TOOLS = new Set(['write_file', 'replace', 'edit', 'WriteFile', 'Edit']);
const SHELL_TOOLS = new Set(['run_shell_command', 'shell', 'Shell', 'execute_command']);
const SEARCH_TOOLS = new Set(['google_web_search', 'web_search', 'WebSearch']);

export function actionsOf(msg) {
  const out = [];
  for (const c of Array.isArray(msg?.toolCalls) ? msg.toolCalls : []) {
    const name = c?.name ?? c?.function?.name;
    const args = c?.args ?? c?.arguments ?? {};
    if (FILE_TOOLS.has(name) && typeof args.file_path === 'string') out.push({ kind: 'file', value: args.file_path });
    else if (SHELL_TOOLS.has(name) && typeof args.command === 'string') out.push({ kind: 'command', value: args.command });
    else if (SEARCH_TOOLS.has(name) && typeof args.query === 'string') out.push({ kind: 'search', value: args.query });
  }
  return out;
}

/** 单个 session 文件 → 会话。导出给测试。 */
export function parseSession(file, json, range, cutoffHour, opts = {}, cwdOf = () => null) {
  if (!json || !Array.isArray(json.messages)) return null;
  const hash = typeof json.projectHash === 'string' ? json.projectHash : path.basename(path.dirname(path.dirname(file)));
  const sid = typeof json.sessionId === 'string' && json.sessionId ? json.sessionId : path.basename(file, '.json');
  const s = newSession(opts.providerId ?? id, sid, { cwd: cwdOf(hash) ?? '.', file });
  for (const m of json.messages) {
    const ts = toIso(m?.timestamp);
    const type = String(m?.type ?? m?.role ?? '').toLowerCase();
    if (type === 'user') pushPrompt(s, textOf(m.content), ts, range, cutoffHour, opts);
    else if (type === 'gemini' || type === 'model' || type === 'assistant' || type === 'qwen') {
      for (const a of actionsOf(m)) pushAction(s, a.kind, a.value, ts, range);
      pushReply(s, textOf(m.content), ts, range, opts);
    }
  }
  return s;
}

export function collect(dirs, range, cutoffHour, opts = {}) {
  const sessions = [];
  for (const d of dirs) {
    const map = projectMap(d);
    const files = walkFiles([path.join(d, 'tmp')], (name, full) => /^session-.*\.json$/.test(name) && path.basename(path.dirname(full)) === 'chats', { maxDepth: 4 });
    for (const file of files) {
      if (!touchedSince(file, range.startUtc)) continue;
      const s = parseSession(file, readJson(file), range, cutoffHour, { ...opts, providerId: opts.providerId ?? id }, (h) => map.get(h) ?? null);
      if (s) sessions.push(s);
    }
  }
  return finish(sessions, cutoffHour);
}
