import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as gemini from '../src/collect/providers/gemini-cli.js';
import * as opencode from '../src/collect/providers/opencode.js';
import * as aider from '../src/collect/providers/aider.js';
import * as cline from '../src/collect/providers/cline.js';
import * as zcode from '../src/collect/providers/zcode.js';
import * as vsc from '../src/collect/providers/vscode-chat.js';
import { parseFile, makeGeneric } from '../src/collect/providers/generic.js';
import { finish, toIso } from '../src/collect/providers/common.js';
import { collectSessions, detectProviders, PROVIDERS } from '../src/collect/sessions.js';
import { defaultSessionDirs } from '../src/config.js';

const RANGE = { startUtc: '2026-09-10T00:00:00.000Z', endUtc: '2026-09-11T00:00:00.000Z' };
const T = (h, m = 0) => `2026-09-10T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'miztrace-prov-'));

test('toIso 认毫秒、秒、ISO，认不出给 null', () => {
  const iso = new Date(1_788_000_000_000).toISOString();
  assert.equal(toIso(1_788_000_000_000), iso, '毫秒');
  assert.equal(toIso(1_788_000_000), iso, '秒');
  assert.equal(toIso('2026-09-10T01:02:03Z'), '2026-09-10T01:02:03.000Z');
  assert.equal(toIso('nope'), null);
  assert.equal(toIso(null), null);
});

test('Gemini CLI：session-*.json 的 user / gemini 消息，projects.json 反查目录，工具调用变动作', () => {
  const home = tmp();
  fs.writeFileSync(path.join(home, 'projects.json'), JSON.stringify({ projects: { '/work/app': 'app-hash' } }));
  const chats = path.join(home, 'tmp', 'app-hash', 'chats');
  fs.mkdirSync(chats, { recursive: true });
  fs.writeFileSync(
    path.join(chats, 'session-2026-09-10T09-00-abc.json'),
    JSON.stringify({
      sessionId: 'abc',
      projectHash: 'app-hash',
      startTime: T(9),
      messages: [
        { id: '1', timestamp: T(9), type: 'user', content: '把登录页改成手机号登录' },
        { id: '2', timestamp: T(9, 1), type: 'gemini', content: '我先看下现有代码。', toolCalls: [{ name: 'run_shell_command', args: { command: 'npm test' } }, { name: 'write_file', args: { file_path: '/work/app/src/login.ts' } }] },
        { id: '3', timestamp: T(9, 5), type: 'gemini', content: '改好了，登录页现在用手机号 + 验证码。' },
      ],
    }),
  );
  const out = gemini.collect([home], RANGE, 4, {});
  assert.equal(out.length, 1);
  assert.equal(out[0].cwd, '/work/app');
  assert.equal(out[0].providerId, 'gemini-cli');
  assert.deepEqual(out[0].prompts.map((p) => p.text), ['把登录页改成手机号登录']);
  assert.deepEqual(out[0].actions.map((a) => [a.kind, a.value]), [['command', 'npm test'], ['file', '/work/app/src/login.ts']]);
  assert.equal(out[0].replies.length, 1);
  assert.match(out[0].replies[0].text, /^改好了/);
});

test('opencode：session / message / part 三层目录拼回会话', () => {
  const home = tmp();
  const st = path.join(home, 'storage');
  const created = Date.parse(T(10));
  fs.mkdirSync(path.join(st, 'session', 'proj'), { recursive: true });
  fs.writeFileSync(path.join(st, 'session', 'proj', 'ses1.json'), JSON.stringify({ id: 'ses1', projectID: 'proj', directory: '/work/oc', title: '修 CI', time: { created, updated: created + 60_000 } }));
  fs.mkdirSync(path.join(st, 'message', 'ses1'), { recursive: true });
  fs.writeFileSync(path.join(st, 'message', 'ses1', 'm1.json'), JSON.stringify({ id: 'm1', sessionID: 'ses1', role: 'user', time: { created } }));
  fs.writeFileSync(path.join(st, 'message', 'ses1', 'm2.json'), JSON.stringify({ id: 'm2', sessionID: 'ses1', role: 'assistant', time: { created: created + 1000, completed: created + 5000 } }));
  fs.mkdirSync(path.join(st, 'part', 'm1'), { recursive: true });
  fs.writeFileSync(path.join(st, 'part', 'm1', 'p1.json'), JSON.stringify({ id: 'p1', messageID: 'm1', type: 'text', text: 'CI 为什么挂了' }));
  fs.mkdirSync(path.join(st, 'part', 'm2'), { recursive: true });
  fs.writeFileSync(path.join(st, 'part', 'm2', 'p1.json'), JSON.stringify({ id: 'p1', messageID: 'm2', type: 'tool', tool: 'bash', state: { input: { command: 'npm ci' } } }));
  fs.writeFileSync(path.join(st, 'part', 'm2', 'p2.json'), JSON.stringify({ id: 'p2', messageID: 'm2', type: 'text', text: '锁文件过期了，已重新生成。' }));
  assert.equal(opencode.detect([home]), true);
  const out = opencode.collect([home], RANGE, 4, {});
  assert.equal(out.length, 1);
  assert.equal(out[0].title, '修 CI');
  assert.equal(out[0].cwd, '/work/oc');
  assert.deepEqual(out[0].prompts.map((p) => p.text), ['CI 为什么挂了']);
  assert.deepEqual(out[0].actions.map((a) => a.value), ['npm ci']);
  assert.equal(out[0].replies[0].text, '锁文件过期了，已重新生成。');
});

test('aider：input.history 带精确时间，chat.history 里对上回复', () => {
  const root = tmp();
  const proj = path.join(root, 'p');
  fs.mkdirSync(proj);
  const local = new Date(T(11)); // 用本机时区写成 aider 的格式
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())} ${pad(local.getHours())}:${pad(local.getMinutes())}:${pad(local.getSeconds())}`;
  fs.writeFileSync(path.join(proj, '.aider.input.history'), `\n# ${stamp}.123\n+把 README 翻成英文\n`);
  fs.writeFileSync(path.join(proj, '.aider.chat.history.md'), `# aider chat started at ${stamp}\n\n#### 把 README 翻成英文\n\n好的，我把 README.md 翻译了。\n\n> Applied edit to README.md\n`);
  assert.equal(aider.detect([root]), true);
  const out = aider.collect([root], RANGE, 4, {});
  assert.equal(out.length, 1);
  assert.equal(out[0].cwd, proj);
  assert.equal(out[0].prompts[0].text, '把 README 翻成英文');
  assert.equal(out[0].prompts[0].ts, T(11));
  assert.match(out[0].replies[0].text, /翻译了/);
});

test('Cline 系：ui_messages.json 的 text / user_feedback 是提问，completion_result 是回复，command 是命令', () => {
  const g = tmp();
  const task = path.join(g, 'tasks', String(Date.parse(T(14))));
  fs.mkdirSync(task, { recursive: true });
  fs.writeFileSync(path.join(task, 'task_metadata.json'), JSON.stringify({ cwd_on_task_initialization: 'D:\\\\work\\\\erp' }));
  fs.writeFileSync(
    path.join(task, 'ui_messages.json'),
    JSON.stringify([
      { ts: Date.parse(T(14)), type: 'say', say: 'text', text: '把导出接口加上分页' },
      { ts: Date.parse(T(14, 1)), type: 'say', say: 'command', text: 'dotnet build' },
      { ts: Date.parse(T(14, 2)), type: 'say', say: 'tool', text: JSON.stringify({ tool: 'editedExistingFile', path: 'src/Export.cs' }) },
      { ts: Date.parse(T(14, 3)), type: 'say', say: 'completion_result', text: '分页加好了，默认每页 50 条。' },
      { ts: Date.parse(T(14, 4)), type: 'say', say: 'user_feedback', text: '改成 100' },
    ]),
  );
  assert.equal(cline.detect([g]), true);
  const out = cline.collect([g], RANGE, 4, { providerId: 'roo-code' });
  assert.equal(out.length, 1);
  assert.equal(out[0].providerId, 'roo-code');
  assert.equal(out[0].cwd, 'D:\\\\work\\\\erp');
  assert.deepEqual(out[0].prompts.map((p) => p.text), ['把导出接口加上分页', '改成 100']);
  assert.deepEqual(out[0].actions.map((a) => [a.kind, a.value]), [['command', 'dotnet build'], ['file', 'src/Export.cs']]);
  assert.equal(out[0].replies[0].text, '分页加好了，默认每页 50 条。');
});

test('Z Code：rollout 按 turnId 归并，标题生成调用不算，system-reminder 不算提问', () => {
  const home = tmp();
  const dir = path.join(home, 'cli', 'rollout');
  fs.mkdirSync(dir, { recursive: true });
  const line = (o) => `${JSON.stringify(o)}\n`;
  fs.writeFileSync(
    path.join(dir, 'model-io-sess_abc.jsonl'),
    line({ sessionId: 'sess_abc', turnId: 't1', startedAt: T(8), completedAt: T(8, 0), request: { messages: [{ role: 'system', content: 'Generate a concise title for this coding session.' }, { role: 'user', content: '帮我看下报错' }] }, response: { text: '报错排查' } }) +
      line({ sessionId: 'sess_abc', turnId: 't1', startedAt: T(8), completedAt: T(8, 1), request: { messages: [{ role: 'system', content: 'You are ZCode' }, { role: 'user', content: '<system-reminder>\nskills…' }, { role: 'user', content: '帮我看下报错' }] }, response: { text: '', toolCalls: [{ toolName: 'bash', args: { command: 'npm test' } }] } }) +
      line({ sessionId: 'sess_abc', turnId: 't1', startedAt: T(8, 1), completedAt: T(8, 2), request: { messages: [{ role: 'system', content: 'You are ZCode' }, { role: 'user', content: '帮我看下报错' }, { role: 'assistant', content: '…' }, { role: 'user', content: 'tool result: 3 failing' }] }, response: { text: '是 mock 没更新，我改了 test/a.js。' } }),
  );
  assert.equal(zcode.detect([home]), true);
  const out = zcode.collect([home], RANGE, 4, {});
  assert.equal(out.length, 1);
  assert.equal(out[0].sessionId, 'sess_abc');
  assert.deepEqual(out[0].prompts.map((p) => p.text), ['帮我看下报错']);
  assert.deepEqual(out[0].actions.map((a) => a.value), ['npm test']);
  assert.equal(out[0].replies.length, 1);
  assert.match(out[0].replies[0].text, /mock 没更新/);
});

test('VS Code 系：workspaceStorage/<hash>/chatSessions/*.json，工作区目录来自 workspace.json', () => {
  const user = tmp();
  const ws = path.join(user, 'workspaceStorage', 'h1');
  fs.mkdirSync(path.join(ws, 'chatSessions'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'workspace.json'), JSON.stringify({ folder: 'file:///work/vs%20app' }));
  fs.writeFileSync(
    path.join(ws, 'chatSessions', 's1.json'),
    JSON.stringify({ version: 3, sessionId: 's1', creationDate: Date.parse(T(15)), requests: [{ message: { text: '解释一下这段正则' }, response: [{ value: '它匹配手机号。' }], timestamp: Date.parse(T(15, 2)) }] }),
  );
  const out = vsc.collect([user], RANGE, 4, { providerId: 'antigravity' });
  assert.equal(out.length, 1);
  assert.equal(out[0].providerId, 'antigravity');
  assert.equal(out[0].cwd, '/work/vs app');
  assert.equal(out[0].prompts[0].text, '解释一下这段正则');
  assert.equal(out[0].replies[0].text, '它匹配手机号。');
  // 不是 User 目录：退回通用格式
  const other = tmp();
  fs.writeFileSync(path.join(other, 'conv.jsonl'), `${JSON.stringify({ role: 'user', content: '写个脚本', timestamp: T(16) })}\n${JSON.stringify({ role: 'assistant', content: '写好了', timestamp: T(16, 1) })}\n`);
  const g = vsc.collect([other], RANGE, 4, { providerId: 'antigravity' });
  assert.equal(g.length, 1);
  assert.equal(g[0].prompts[0].text, '写个脚本');
});

test('通用适配器：只认 role + 文本 + 时间齐全的记录；没时间的按文件时间兜底；嵌套里也能找到', () => {
  const dir = tmp();
  const f = path.join(dir, 'a.json');
  fs.writeFileSync(f, JSON.stringify({ meta: { workspace: '/work/k' }, history: [{ role: 'user', content: [{ type: 'text', text: '把日志级别改成 debug' }], created_at: T(12) }, { role: 'assistant', content: '改了 config.yaml', created_at: T(12, 1) }, { role: 'tool', content: 'ignored' }] }));
  const s = finish([parseFile(f, fs.readFileSync(f, 'utf8'), RANGE, 4, {}, 'kimi-code')], 4)[0];
  assert.equal(s.providerId, 'kimi-code');
  assert.equal(s.cwd, '/work/k');
  assert.deepEqual(s.prompts.map((p) => p.text), ['把日志级别改成 debug']);
  assert.equal(s.replies[0].text, '改了 config.yaml');
  // 没有任何时间戳：文件是今天改的就按文件时间记
  const g = path.join(dir, 'b.json');
  fs.writeFileSync(g, JSON.stringify([{ role: 'user', content: '没时间的提问' }]));
  const now = new Date();
  const range = { startUtc: new Date(now.getTime() - 3_600_000).toISOString(), endUtc: new Date(now.getTime() + 3_600_000).toISOString() };
  const s2 = finish([parseFile(g, fs.readFileSync(g, 'utf8'), range, 4, {}, 'x')], 4)[0];
  assert.equal(s2.prompts.length, 1);
  // 完全不像对话的 JSON：不出会话
  const h = path.join(dir, 'c.json');
  fs.writeFileSync(h, JSON.stringify({ settings: { theme: 'dark' } }));
  assert.equal(parseFile(h, fs.readFileSync(h, 'utf8'), range, 4, {}, 'x'), null);
  assert.equal(makeGeneric('x').collect([dir], range, 4, {}).length >= 1, true);
});

test('CodeBuddy / WorkBuddy：先按 Claude Code 的 jsonl 读，认不出再退回通用格式；都标通用', () => {
  const home = tmp();
  const proj = path.join(home, 'projects', '-work-app');
  fs.mkdirSync(proj, { recursive: true });
  const line = (o) => `${JSON.stringify(o)}\n`;
  fs.writeFileSync(
    path.join(proj, 'sess.jsonl'),
    line({ type: 'user', sessionId: 'wb1', timestamp: T(9), cwd: '/work/app', message: { content: '把这周的周报整理一下' } }) +
      line({ type: 'assistant', sessionId: 'wb1', timestamp: T(9, 2), message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/work/app/周报.md' } }] } }) +
      line({ type: 'assistant', sessionId: 'wb1', timestamp: T(9, 3), message: { content: [{ type: 'text', text: '周报整理好了，放在 周报.md。' }] } }),
  );
  const wb = PROVIDERS.find((p) => p.id === 'workbuddy');
  const cb = PROVIDERS.find((p) => p.id === 'codebuddy');
  assert.ok(wb && cb && wb.generic && cb.generic, '两个都在注册表里，且标通用');
  const out = wb.mod.collect([home], RANGE, 4, {});
  assert.equal(out.length, 1);
  assert.equal(out[0].providerId, 'workbuddy', '会话挂在 WorkBuddy 名下，不是 claude-code');
  assert.equal(out[0].cwd, '/work/app');
  assert.deepEqual(out[0].prompts.map((p) => p.text), ['把这周的周报整理一下']);
  assert.deepEqual(out[0].actions.map((a) => [a.kind, a.value]), [['file', '/work/app/周报.md']]);
  assert.match(out[0].replies[0].text, /^周报整理好了/);
  // 不是 Claude Code 格式：退回通用格式
  const home2 = tmp();
  fs.writeFileSync(path.join(home2, 'chat.json'), JSON.stringify({ messages: [{ role: 'user', content: '帮我写个邮件', timestamp: T(10) }, { role: 'assistant', content: '写好了。', timestamp: T(10, 1) }] }));
  const out2 = cb.mod.collect([home2], RANGE, 4, {});
  assert.equal(out2.length, 1);
  assert.equal(out2[0].providerId, 'codebuddy');
  assert.deepEqual(out2[0].prompts.map((p) => p.text), ['帮我写个邮件']);
  const dirs = defaultSessionDirs({ home: '/h', platform: 'darwin', env: {} });
  assert.ok(dirs.workbuddy.includes('/h/.workbuddy'));
  assert.ok(dirs.workbuddy.some((d) => d.includes('Application Support/WorkBuddy')));
  const win = defaultSessionDirs({ home: 'C:\\Users\\x', platform: 'win32', env: { APPDATA: 'C:\\Users\\x\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' } });
  // 路径按传入的 platform 拼，不跟运行测试的机器走：macOS 上也要拼出反斜杠，Windows 上跑 darwin 用例也要拼出 /
  assert.equal(win.workbuddy[0], 'C:\\Users\\x\\.workbuddy', '按目标平台拼路径');
  assert.ok(win.workbuddy.some((d) => d.includes('Roaming') && d.endsWith('WorkBuddy')), 'Roaming 下');
  assert.ok(win.workbuddy.some((d) => d.includes('Local') && d.endsWith('WorkBuddy')), 'Local 下');
  assert.ok(win.workbuddy.some((d) => d.endsWith('.workbuddy')), '家目录点目录');
});

test('注册表：每个适配器都有默认目录；没装的工具在 report 里是 absent，前端据此不显示', () => {
  const dirs = defaultSessionDirs({ home: '/h', platform: 'win32', env: { APPDATA: 'C:\\\\Users\\\\x\\\\AppData\\\\Roaming', LOCALAPPDATA: 'C:\\\\Users\\\\x\\\\AppData\\\\Local' } });
  for (const p of PROVIDERS) if (!p.usesRoots) assert.ok(Array.isArray(dirs[p.id]) && dirs[p.id].length, `${p.id} 缺默认目录`);
  assert.ok(dirs.cline.some((d) => d.includes('saoudrizwan.claude-dev')));
  assert.ok(dirs.cursor[0].includes('Cursor'));
  const empty = tmp();
  const sessionDirs = Object.fromEntries(PROVIDERS.map((p) => [p.id, [path.join(empty, p.id)]]));
  const { report, sessions } = collectSessions(sessionDirs, RANGE, 4, { roots: [empty] });
  assert.equal(sessions.length, 0);
  assert.ok(report.every((r) => r.status === 'absent'));
  assert.ok(detectProviders(sessionDirs, [empty]).every((p) => p.found === false));
  assert.ok(PROVIDERS.filter((p) => p.generic).length >= 5, '通用适配器覆盖的工具要标出来');
});

// ---- 2026-09-12：opencode 的 SQLite 版；Hermes Agent ----
test('opencode 新版：opencode.db 里 session / message / part 三张表（data 列存 JSON）也能读', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-oc-db-'));
  const db = new DatabaseSync(path.join(home, 'opencode.db'));
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, data TEXT); CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT); CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, data TEXT)');
  const t0 = Date.parse('2026-09-10T02:00:00Z');
  db.prepare('INSERT INTO session VALUES (?, ?)').run('ses_1', JSON.stringify({ id: 'ses_1', directory: '/tmp/proj', title: '修同步', time: { created: t0, updated: t0 + 60_000 } }));
  db.prepare('INSERT INTO message VALUES (?, ?, ?)').run('msg_1', 'ses_1', JSON.stringify({ id: 'msg_1', sessionID: 'ses_1', role: 'user', time: { created: t0 } }));
  db.prepare('INSERT INTO message VALUES (?, ?, ?)').run('msg_2', 'ses_1', JSON.stringify({ id: 'msg_2', sessionID: 'ses_1', role: 'assistant', time: { created: t0 + 30_000, completed: t0 + 50_000 } }));
  db.prepare('INSERT INTO part VALUES (?, ?, ?)').run('prt_1', 'msg_1', JSON.stringify({ id: 'prt_1', type: 'text', text: '为什么没同步' }));
  db.prepare('INSERT INTO part VALUES (?, ?, ?)').run('prt_2', 'msg_2', JSON.stringify({ id: 'prt_2', type: 'tool', tool: 'edit', state: { input: { filePath: '/tmp/proj/a.ts' } } }));
  db.prepare('INSERT INTO part VALUES (?, ?, ?)').run('prt_3', 'msg_2', JSON.stringify({ id: 'prt_3', type: 'text', text: '改好了' }));
  db.close();
  assert.equal(opencode.detect([home]), true, '只有 .db 没有 storage/ 目录也算装了');
  const out = opencode.collect([home], RANGE, 4, {});
  assert.equal(out.length, 1);
  assert.equal(out[0].cwd, '/tmp/proj');
  assert.equal(out[0].title, '修同步');
  assert.deepEqual(out[0].prompts.map((p) => p.text), ['为什么没同步']);
  assert.deepEqual(out[0].actions.map((a) => [a.kind, a.value]), [['file', '/tmp/proj/a.ts']]);
  assert.equal(out[0].replies[0].text, '改好了');
});

test('Hermes Agent：~/.hermes/state.db 的 sessions + messages 表按候选列名读；tool_calls 变成动作', async () => {
  const hermes = await import('../src/collect/providers/hermes.js');
  const { DatabaseSync } = await import('node:sqlite');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-hermes-'));
  const db = new DatabaseSync(path.join(home, 'state.db'));
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, working_dir TEXT); CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL)');
  const t0 = Date.parse('2026-09-10T03:00:00Z') / 1000;
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('s1', '整理日志', '/tmp/logs');
  db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run('s1', 'user', '把昨天的日志归档', t0);
  db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run('s1', 'assistant', JSON.stringify({ content: '好的', tool_calls: [{ function: { name: 'terminal', arguments: JSON.stringify({ command: 'mv a.md archive/' }) } }] }), t0 + 5);
  db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run('s1', 'assistant', '归档完成', t0 + 9);
  db.close();
  assert.equal(hermes.detect([home]), true);
  const out = hermes.collect([home], RANGE, 4, {});
  assert.equal(out.length, 1);
  assert.equal(out[0].providerId, 'hermes');
  assert.equal(out[0].cwd, '/tmp/logs');
  assert.equal(out[0].title, '整理日志');
  assert.deepEqual(out[0].prompts.map((p) => p.text), ['把昨天的日志归档']);
  assert.deepEqual(out[0].actions.map((a) => [a.kind, a.value]), [['command', 'mv a.md archive/']]);
  assert.equal(out[0].replies[0].text, '归档完成', '一轮里只留最后一段回复');
});
