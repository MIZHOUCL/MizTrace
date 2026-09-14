import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as cc from '../src/collect/providers/claude-code.js';
import * as codex from '../src/collect/providers/codex.js';
import { dayRange } from '../src/time.js';

const RANGE = dayRange('2026-09-03', 4);
const TS = '2026-09-03T10:00:00.000Z'; // 落在窗口内
const OLD = '2026-08-01T10:00:00.000Z'; // 窗口外

function tmpdir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `miztrace-${name}-`));
  return dir;
}

function writeJsonl(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
}

test('claude-code: extractPrompt 只取 text 块，丢弃工具结果', () => {
  assert.equal(cc.extractPrompt({ content: '  纯字符串  ' }), '纯字符串');
  assert.equal(
    cc.extractPrompt({ content: [{ type: 'text', text: '要点' }, { type: 'tool_result', content: '一大堆输出' }] }),
    '要点',
  );
  assert.equal(cc.extractPrompt({ content: [{ type: 'tool_result', content: 'x' }] }), null);
});

test('claude-code: harness 注入的内容不算用户输入', () => {
  assert.equal(cc.cleanPrompt('<command-name>foo</command-name>'), null);
  assert.equal(cc.cleanPrompt('<system-reminder>提醒</system-reminder>'), null);
  assert.equal(cc.cleanPrompt('Caveat: 一些说明'), null);
  assert.equal(cc.cleanPrompt('   '), null);
  assert.equal(cc.cleanPrompt('真实输入'), '真实输入');
});

test('claude-code: 只从写类工具取文件，Read/Grep 忽略', () => {
  const actions = cc.extractActions({
    content: [
      { type: 'tool_use', name: 'Edit', input: { file_path: '/a/b.ts' } },
      { type: 'tool_use', name: 'Read', input: { file_path: '/a/ignored.ts' } },
      { type: 'tool_use', name: 'Grep', input: { pattern: 'x' } },
      { type: 'tool_use', name: 'Bash', input: { description: '跑测试' } },
      { type: 'tool_use', name: 'Bash', input: { command: 'x'.repeat(200) } },
    ],
  });
  assert.deepEqual(actions[0], { kind: 'file', value: '/a/b.ts' });
  assert.deepEqual(actions[1], { kind: 'command', value: '跑测试' });
  assert.equal(actions[2].value.length, 80);
  assert.equal(actions.length, 3);
});

test('claude-code: 跳过 isSidechain、应用 ai-title、按窗口过滤、同文件只记一次', () => {
  const dir = tmpdir('cc');
  writeJsonl(path.join(dir, '-Users-me-proj', 's1.jsonl'), [
    { type: 'user', sessionId: 's1', timestamp: TS, cwd: '/Users/me/proj', gitBranch: 'main', message: { content: '主链输入' } },
    // 子 agent 转录：工作已在主链出现，必须跳过
    { type: 'user', sessionId: 's1', timestamp: TS, isSidechain: true, message: { content: '子 agent 输入' } },
    // 窗口外
    { type: 'user', sessionId: 's1', timestamp: OLD, message: { content: '上个月的输入' } },
    { type: 'assistant', sessionId: 's1', timestamp: TS, message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/a.ts' } }] } },
    { type: 'assistant', sessionId: 's1', timestamp: TS, message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/a.ts' } }] } },
    // ai-title 不受窗口限制
    { type: 'ai-title', sessionId: 's1', timestamp: OLD, aiTitle: '正式标题' },
    // 没有 sessionId 的行
    { type: 'user', timestamp: TS, message: { content: '没有 sessionId' } },
  ]);
  const sessions = cc.collect([dir], RANGE, 4);
  assert.equal(sessions.length, 1);
  const s = sessions[0];
  assert.equal(s.title, '正式标题');
  assert.equal(s.cwd, '/Users/me/proj');
  assert.equal(s.gitBranch, 'main');
  assert.deepEqual(s.prompts.map((p) => p.text), ['主链输入']);
  assert.equal(s.actions.length, 1, '同一文件被 Edit 又 Write 只记一次');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('claude-code: providerId 可覆盖、maxFiles 限制遍历（给照着它做的工具复用）', () => {
  const dir = tmpdir('cc-reuse');
  writeJsonl(path.join(dir, 'p', 'a.jsonl'), [{ type: 'user', sessionId: 'a', timestamp: TS, message: { content: 'A' } }]);
  writeJsonl(path.join(dir, 'p', 'b.jsonl'), [{ type: 'user', sessionId: 'b', timestamp: TS, message: { content: 'B' } }]);
  const all = cc.collect([dir], RANGE, 4, { providerId: 'codebuddy' });
  assert.equal(all.length, 2);
  assert.ok(all.every((s) => s.providerId === 'codebuddy'));
  assert.equal(cc.collect([dir], RANGE, 4, { maxFiles: 1 }).length, 1);
  assert.equal(cc.collect([dir], RANGE, 4, { maxDepth: 0 }).length, 0, '深度 0 只看根目录本身');
  assert.equal(cc.collect([dir], RANGE, 4)[0].providerId, 'claude-code', '不传就是自己');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('claude-code: subagents / workflows 目录不算用户会话', () => {
  const dir = tmpdir('cc2');
  const rec = [{ type: 'user', sessionId: 'x', timestamp: TS, message: { content: '子 agent 的活' } }];
  writeJsonl(path.join(dir, '-proj', 'subagents', 'a.jsonl'), rec);
  writeJsonl(path.join(dir, '-proj', 'workflows', 'b.jsonl'), rec);
  assert.equal(cc.collect([dir], RANGE, 4).length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('claude-code: 坏行跳过但不中断整个文件', () => {
  const dir = tmpdir('cc3');
  const file = path.join(dir, '-proj', 's.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `{坏 JSON\n${JSON.stringify({ type: 'user', sessionId: 's', timestamp: TS, message: { content: '好行' } })}\n`,
    'utf8',
  );
  const sessions = cc.collect([dir], RANGE, 4);
  assert.equal(sessions.length, 1);
  assert.deepEqual(sessions[0].prompts.map((p) => p.text), ['好行']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('codex: 只取 role=user 的 message，developer 忽略', () => {
  assert.equal(codex.extractPrompt({ role: 'user', content: [{ type: 'input_text', text: '用户输入' }] }), '用户输入');
  assert.equal(codex.extractPrompt({ role: 'developer', content: [{ type: 'input_text', text: '系统指令' }] }), null);
  assert.equal(codex.extractPrompt({ role: 'user', content: [{ type: 'image', url: 'x' }] }), null);
});

test('codex: exec_command 取 cmd，apply_patch 取文件路径', () => {
  const exec = codex.extractActions({ name: 'exec_command', arguments: JSON.stringify({ cmd: 'npm test', login: true }) });
  assert.deepEqual(exec, [{ kind: 'command', value: 'npm test' }]);
  // arguments 不是合法 JSON 时不应抛错
  assert.deepEqual(codex.extractActions({ name: 'exec_command', arguments: '{坏' }), []);
  const patch = ['*** Begin Patch', '*** Update File: src/a.ts', '*** Add File: src/b.ts', '*** End Patch'].join('\n');
  assert.deepEqual(codex.extractActions({ name: 'apply_patch', input: patch }), [
    { kind: 'file', value: 'src/a.ts' },
    { kind: 'file', value: 'src/b.ts' },
  ]);
  assert.deepEqual(codex.extractActions({ name: 'write_stdin', arguments: '{}' }), []);
});

test('codex: event_msg/user_message 不重复计数', () => {
  const session = { prompts: [], actions: [], msgIndex: 0, seen: new Set(), firstTs: null, lastTs: null, title: null, cwd: '.' };
  const userItem = { timestamp: TS, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '同一句话' }] } };
  const eventDup = { timestamp: TS, type: 'event_msg', payload: { type: 'user_message', message: '同一句话' } };
  codex.ingest(session, userItem, RANGE, 4);
  codex.ingest(session, eventDup, RANGE, 4);
  codex.ingest(session, { timestamp: TS, type: 'turn_context', payload: {} }, RANGE, 4);
  assert.equal(session.prompts.length, 1);
});

test('codex: session_meta 提供 cwd 与 cli_version', () => {
  const session = { prompts: [], actions: [], msgIndex: 0, seen: new Set(), firstTs: null, lastTs: null, title: null, cwd: '.' };
  codex.ingest(
    session,
    { timestamp: TS, type: 'session_meta', payload: { id: 'thread-1', cwd: '/Users/me/proj', cli_version: '1.2.3', git: { branch: 'dev' } } },
    RANGE,
    4,
  );
  assert.equal(session.cwd, '/Users/me/proj');
  assert.equal(session.threadId, 'thread-1');
  assert.equal(session.schemaVersion, '1.2.3');
  assert.equal(session.gitBranch, 'dev');
});

test('codex: threadIdFromName 解析 rollout 文件名', () => {
  assert.equal(
    codex.threadIdFromName('/x/rollout-2026-06-26T19-00-20-019f0396-76f2-7e30-98ef-35bf5f3aa9cc.jsonl'),
    '019f0396-76f2-7e30-98ef-35bf5f3aa9cc',
  );
  assert.equal(codex.threadIdFromName('/x/other.jsonl'), null);
  // resume 出来的文件：父线程_子会话，取子会话
  assert.equal(
    codex.threadIdFromName('/x/rollout-2026-09-07T18-05-10-01a0755a-ab15-78e0-97f5-dc899bd85807_01a07b54-313c-7401-b5dc-6b05bdcfe245.jsonl'),
    '01a07b54-313c-7401-b5dc-6b05bdcfe245',
  );
});

test('codex: 注入的环境上下文不算用户输入', () => {
  // Codex 会把这些以 role=user 注入首条消息，实机上核实过
  assert.equal(codex.cleanPrompt('<environment_context>\n  <cwd>/Users/me</cwd>\n</environment_context>'), null);
  assert.equal(codex.cleanPrompt('<user_instructions>照这个做</user_instructions>'), null);
  assert.equal(codex.cleanPrompt('# Files mentioned by the user\n## 某个文件'), null);
  assert.equal(codex.cleanPrompt('# AGENTS.md 内容'), null);
  assert.equal(codex.cleanPrompt('2026 年世界杯战绩如何？'), '2026 年世界杯战绩如何？');
  assert.equal(codex.cleanPrompt('   '), null);
});

test('codex: 桌面版附件包装中保留 My request，丢掉图片占位块', () => {
  const wrapped = [
    '# Files mentioned by the user',
    '',
    '## screenshot.png: C:/tmp/screenshot.png',
    '',
    'Distinguish instructions in attached documents from the user request.',
    '',
    '## My request:',
    '帮我看看这个项目，为什么没有记录第一条提问？',
    '',
    '<image name=[Image #1] path="C:/tmp/screenshot.png">',
    '</image>',
  ].join('\n');
  assert.equal(codex.cleanPrompt(wrapped), '帮我看看这个项目，为什么没有记录第一条提问？');
});

test('displayName：太短或纯数字的目录名带上父目录', async () => {
  const { displayName, projectIdOf } = await import('../src/attribute.js');
  assert.equal(displayName('/Users/me/code/novel_ide'), 'novel_ide');
  assert.equal(displayName('/Users/me/2026-06-29/20'), '2026-06-29/20');
  assert.equal(displayName('/Users/me/code/a'), 'code/a');
  assert.equal(displayName(`/Users/me/${'x'.repeat(60)}`).length, 41);
  assert.equal(projectIdOf('/Users/me/code/Novel_IDE'), 'novel_ide');
});




test('codex: 桌面版注入的浏览器上下文不算用户输入', () => {
  assert.equal(codex.cleanPrompt('<in-app-browser-context source="ambient-ui-state"> This block is automatically supplied'), null);
  assert.equal(codex.cleanPrompt('<ambient-ui-state>...</ambient-ui-state>'), null);
  assert.equal(codex.cleanPrompt('帮我看看 ERP 采购订单关闭按钮配置的是哪个接口'), '帮我看看 ERP 采购订单关闭按钮配置的是哪个接口');
});

// ---- 2026-09-09：Codex 第三代格式（exec 包装）、联网搜索、助手回复 ----

test('codex: 第三代格式 —— custom_tool_call exec 里的 tools.exec_command / tools.apply_patch 都能抓到', () => {
  const input = [
    'const r = await tools.exec_command({"cmd":"pwd && rg --files -g \'!node_modules\' | sed -n \'1,240p\'","workdir":"/Users/me/proj","yield_time_ms":10000}); text(r.output);',
    'const patch = "*** Begin Patch\\n*** Add File: build_resume_docx.py\\n+from docx import Document\\n*** Update File: src/a.ts\\n@@\\n-x\\n+y\\n*** End Patch";',
    'const p = await tools.apply_patch(patch); text(p);',
    'const q = await tools.exec_command({"cmd":"echo \\"a }) b\\" && ls","workdir":"/x"}); text(q.output);',
  ].join('\n');
  const actions = codex.extractActions({ type: 'custom_tool_call', name: 'exec', input });
  assert.deepEqual(actions, [
    { kind: 'command', value: "pwd && rg --files -g '!node_modules' | sed -n '1,240p'" },
    { kind: 'command', value: 'echo "a }) b" && ls' },
    { kind: 'file', value: 'build_resume_docx.py' },
    { kind: 'file', value: 'src/a.ts' },
  ]);
  // 多行脚本压成一行
  assert.equal(codex.extractActions({ type: 'custom_tool_call', name: 'exec', input: 'tools.exec_command({"cmd":"sed -n 1p a\\nsed -n 2p b"})' })[0].value, 'sed -n 1p a sed -n 2p b');
  // 其他包装工具（update_plan / view_image）不算动作
  assert.deepEqual(codex.extractActions({ type: 'custom_tool_call', name: 'exec', input: 'await tools.update_plan({plan:[]}); await tools.view_image({path:"x.png"});' }), []);
});

test('codex: 旧格式 shell（command 数组）、local_shell_call、web_search_call', () => {
  assert.deepEqual(codex.extractActions({ type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'npm test'] }) }), [{ kind: 'command', value: 'npm test' }]);
  assert.deepEqual(codex.extractActions({ type: 'local_shell_call', action: { command: ['ls', '-la'] } }), [{ kind: 'command', value: 'ls -la' }]);
  assert.deepEqual(codex.extractActions({ type: 'web_search_call', action: { type: 'search', query: 'RikkaHub GitHub' } }), [{ kind: 'search', value: 'RikkaHub GitHub' }]);
  assert.deepEqual(codex.extractActions({ type: 'function_call', name: 'apply_patch', arguments: JSON.stringify({ input: '*** Begin Patch\n*** Delete File: old.md\n*** End Patch' }) }), [{ kind: 'file', value: 'old.md' }]);
});

test('codex: 每轮的最终回复（phase=final_answer）挂到它答的那条提问上，commentary 不算', () => {
  const session = { prompts: [], actions: [], replies: [], msgIndex: 0, seen: new Set(), firstTs: null, lastTs: null, title: null, cwd: '.', pendingReply: null, lastPromptIndex: null };
  const t = (s) => `2026-09-03T10:00:${String(s).padStart(2, '0')}.000Z`;
  const user = (s, text) => ({ timestamp: t(s), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
  const asst = (s, text, phase) => ({ timestamp: t(s), type: 'response_item', payload: { type: 'message', role: 'assistant', phase, content: [{ type: 'output_text', text }] } });
  codex.ingest(session, user(1, '帮我修同步'), RANGE, 4);
  codex.ingest(session, asst(2, '我先看看代码结构。', 'commentary'), RANGE, 4);
  codex.ingest(session, { timestamp: t(3), type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: 'tools.exec_command({"cmd":"ls"})' } }, RANGE, 4);
  codex.ingest(session, asst(4, '## 改好了\n\n- 把 `FormId` 传过去\n\n```js\nconst x = 1;\n```\n', 'final_answer'), RANGE, 4);
  codex.ingest(session, asst(5, '（多余的 commentary 不该覆盖 final_answer）', 'commentary'), RANGE, 4);
  codex.ingest(session, user(6, '再加个测试'), RANGE, 4);
  codex.ingest(session, asst(7, '没有 phase 的旧格式，取最后一段', undefined), RANGE, 4);
  codex.flushReply(session, 4);
  assert.equal(session.replies.length, 2);
  assert.equal(session.replies[0].promptIndex, session.prompts[0].index);
  assert.equal(session.replies[0].text, '改好了 把 FormId 传过去 [代码]', 'Markdown 标记去掉，代码块换成 [代码]');
  assert.equal(session.replies[0].index, 4, 'final_answer 那条的序号');
  assert.equal(session.replies[1].promptIndex, session.prompts[1].index);
  assert.equal(session.replies[1].text, '没有 phase 的旧格式，取最后一段');
  assert.equal(session.actions.length, 1);

  const off = { prompts: [], actions: [], replies: [], msgIndex: 0, seen: new Set(), firstTs: null, lastTs: null, title: null, cwd: '.', pendingReply: null, lastPromptIndex: null };
  codex.ingest(off, user(1, 'x'), RANGE, 4, { replies: false });
  codex.ingest(off, asst(2, '回复', 'final_answer'), RANGE, 4, { replies: false });
  codex.flushReply(off, 4);
  assert.equal(off.replies.length, 0, 'replies=false 时一条都不记');
});

test('claude-code: 一轮里最后一段 text 是回复；tool_result 不算新一轮；harness 状态文本不算回复', () => {
  const dir = tmpdir('cc-replies');
  const t = (s) => `2026-09-03T10:00:${String(s).padStart(2, '0')}.000Z`;
  writeJsonl(path.join(dir, '-proj', 's1.jsonl'), [
    { type: 'user', sessionId: 's1', timestamp: t(1), cwd: '/p', message: { content: '把扫描器改成惰性求值' } },
    { type: 'assistant', sessionId: 's1', timestamp: t(2), message: { content: [{ type: 'text', text: '我先看看现有实现。' }] } },
    { type: 'assistant', sessionId: 's1', timestamp: t(3), message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/p/scanner.ts' } }] } },
    { type: 'user', sessionId: 's1', timestamp: t(4), message: { content: [{ type: 'tool_result', content: 'ok' }] } },
    { type: 'assistant', sessionId: 's1', timestamp: t(5), message: { content: [{ type: 'text', text: '**改好了**：`scanner.ts` 现在只在需要时算 hash。' }] } },
    { type: 'user', sessionId: 's1', timestamp: t(6), message: { content: '跑一下测试' } },
    { type: 'assistant', sessionId: 's1', timestamp: t(7), message: { content: [{ type: 'text', text: 'API Error: Request rejected (429)' }] } },
    { type: 'user', sessionId: 's1', timestamp: t(8), message: { content: '再试' } },
    { type: 'assistant', sessionId: 's1', timestamp: t(9), message: { content: [{ type: 'text', text: '全绿，97 个测试。' }] } },
  ]);
  const [s] = cc.collect([dir], RANGE, 4);
  assert.equal(s.prompts.length, 3);
  assert.deepEqual(
    s.replies.map((r) => [r.promptIndex, r.text]),
    [
      [s.prompts[0].index, '改好了：scanner.ts 现在只在需要时算 hash。'],
      [s.prompts[2].index, '全绿，97 个测试。'],
    ],
    '第一轮取最后一段而不是「我先看看」；429 那条不算回复',
  );
  assert.equal(cc.collect([dir], RANGE, 4, { replies: false })[0].replies.length, 0);
  assert.deepEqual(cc.extractActions({ content: [{ type: 'tool_use', name: 'WebSearch', input: { query: 'node sqlite bigint' } }] }), [{ kind: 'search', value: 'node sqlite bigint' }]);
  fs.rmSync(dir, { recursive: true, force: true });
});
