/**
 * Cline 系（Cline / Roo Code / Kilo Code）适配器。它们都是 VS Code 插件，任务存在 globalStorage 下：
 *   <globalStorage>/<插件 id>/tasks/<起始毫秒>/ui_messages.json
 *     [{ ts, type: 'say'|'ask', say?: 'text'|'user_feedback'|'completion_result'|'command'|'tool'|…, ask?: …, text }]
 *   同目录的 task_metadata.json 里可能有 cwd（字段名各版本不同，都试一下）。
 * 提问 = say:text（首条任务）与 say:user_feedback；回复 = say:completion_result；命令 = say:command。
 */
import fs from 'node:fs';
import path from 'node:path';
import { newSession, pushPrompt, pushReply, pushAction, finish, toIso, readJson, walkFiles, touchedSince } from './common.js';

export const id = 'cline';

export function detect(dirs) {
  return dirs.some((d) => fs.existsSync(path.join(d, 'tasks')));
}

function cwdOf(taskDir) {
  const meta = readJson(path.join(taskDir, 'task_metadata.json'));
  for (const k of ['cwd', 'cwd_on_task_initialization', 'workspace', 'workspacePath']) if (typeof meta?.[k] === 'string' && meta[k]) return meta[k];
  const ws = meta?.files_in_context?.[0]?.path;
  return typeof ws === 'string' ? path.dirname(ws) : '.';
}

/** ui_messages.json 的内容 → 会话。导出给测试。 */
export function parseTask(taskDir, messages, range, cutoffHour, opts = {}, providerId = id) {
  if (!Array.isArray(messages)) return null;
  const s = newSession(providerId, `${providerId}:${path.basename(taskDir)}`, { cwd: cwdOf(taskDir), file: path.join(taskDir, 'ui_messages.json') });
  let first = true;
  for (const m of messages) {
    const ts = toIso(m?.ts);
    if (m?.type !== 'say' || typeof m.text !== 'string') continue;
    if ((m.say === 'text' && first) || m.say === 'user_feedback') {
      first = false;
      pushPrompt(s, m.text, ts, range, cutoffHour, opts);
    } else if (m.say === 'completion_result') pushReply(s, m.text, ts, range, opts);
    else if (m.say === 'command') pushAction(s, 'command', m.text, ts, range);
    else if (m.say === 'tool') {
      let t = null;
      try {
        t = JSON.parse(m.text);
      } catch {
        t = null;
      }
      if (t && typeof t.path === 'string' && /^(editedExistingFile|newFileCreated|appliedDiff)$/.test(String(t.tool))) pushAction(s, 'file', t.path, ts, range);
    }
  }
  return s;
}

export function collect(dirs, range, cutoffHour, opts = {}) {
  const sessions = [];
  const files = walkFiles(dirs, (n, full) => n === 'ui_messages.json' && path.basename(path.dirname(path.dirname(full))) === 'tasks', { maxDepth: 3, maxFiles: 2000 });
  for (const file of files) {
    if (!touchedSince(file, range.startUtc)) continue;
    const s = parseTask(path.dirname(file), readJson(file), range, cutoffHour, opts, opts.providerId ?? id);
    if (s) sessions.push(s);
  }
  return finish(sessions, cutoffHour);
}
