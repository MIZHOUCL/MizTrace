import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { chat, testConnection, detectProtocol, openaiEndpoint, anthropicEndpoint } from '../src/ai/provider.js';
import { scanSecrets, redactPII, scrubSecrets, redactHome } from '../src/ai/redact.js';
import { buildPrompt, parseModelJson, entriesToJournal, estimateTokens, writeWithAI, SecretsFoundError, ManagedDeviceError, assertOutboundAllowed } from '../src/ai/write.js';

/**
 * 假 fetch：记录请求、按脚本回包。不开 socket —— 沙箱环境下 listen 会 EPERM，
 * 而且 provider 的正确性在于「发出去的请求长什么样」，用假 fetch 验证更直接。
 */
function fakeFetch(handler) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    const headers = Object.fromEntries(Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    seen.push({ method: init?.method, url: String(url), headers, body });
    const out = handler({ url: String(url), body });
    const status = out.status ?? 200;
    return { ok: status >= 200 && status < 300, status, statusText: '', text: async () => JSON.stringify(out.json) };
  };
  return { fetchImpl, seen };
}

const KEY = 'sk-test-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';

test('协议自动识别与端点拼接', () => {
  assert.equal(detectProtocol('https://api.anthropic.com'), 'anthropic');
  assert.equal(detectProtocol('https://api.deepseek.com/v1'), 'openai');
  assert.equal(detectProtocol('https://api.anthropic.com', 'openai'), 'openai', '显式指定优先');
  assert.equal(openaiEndpoint('https://api.deepseek.com'), 'https://api.deepseek.com/v1/chat/completions', '只填域名自动补 /v1');
  assert.equal(openaiEndpoint('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(openaiEndpoint('http://localhost:11434/v1'), 'http://localhost:11434/v1/chat/completions');
  assert.equal(anthropicEndpoint(''), 'https://api.anthropic.com/v1/messages');
  assert.equal(anthropicEndpoint('https://proxy.example.com'), 'https://proxy.example.com/v1/messages');
});

test('openai 协议：请求形状正确，能解析回复与用量', async () => {
  const srv = fakeFetch(() => ({ json: { model: 'deepseek-chat', choices: [{ message: { content: '  你好  ' } }], usage: { prompt_tokens: 12, completion_tokens: 3 } } }));
  {
    const r = await chat({ protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKey: KEY, model: 'deepseek-chat', maxTokens: 100, temperature: 0.2 }, { system: 'S', user: 'U' }, srv);
    assert.equal(r.text, '你好');
    assert.deepEqual(r.usage, { input: 12, output: 3 });
    assert.equal(r.protocol, 'openai');
    const req = srv.seen[0];
    assert.equal(req.url, 'https://api.deepseek.com/v1/chat/completions');
    assert.equal(req.headers.authorization, `Bearer ${KEY}`);
    assert.equal(req.body.model, 'deepseek-chat');
    assert.equal(req.body.max_tokens, 100);
    assert.equal(req.body.temperature, 0.2);
    assert.deepEqual(req.body.messages.map((m) => m.role), ['system', 'user']);
  }
});

test('anthropic 协议：x-api-key 头、system 独立字段、不带 temperature', async () => {
  const srv = fakeFetch(() => ({ json: { model: 'claude-x', content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }], usage: { input_tokens: 5, output_tokens: 2 } } }));
  {
    const r = await chat({ protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: KEY, model: 'claude-x', temperature: 0.9 }, { system: 'S', user: 'U' }, srv);
    assert.equal(r.text, 'A\nB');
    assert.deepEqual(r.usage, { input: 5, output: 2 });
    const req = srv.seen[0];
    assert.equal(req.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(req.headers['x-api-key'], KEY);
    assert.equal(req.headers['anthropic-version'], '2023-06-01');
    assert.equal(req.body.system, 'S');
    assert.equal(req.body.temperature, undefined, '新一代 Anthropic 模型不接受采样参数');
  }
});

test('HTTP 错误：报错里带状态码与正文片段，但绝不带 API key', async () => {
  const srv = fakeFetch(() => ({ status: 401, json: { error: { message: `invalid key ${KEY}` } } }));
  {
    await assert.rejects(
      chat({ protocol: 'openai', baseUrl: 'https://x.example/v1', apiKey: KEY, model: 'm' }, { system: 'S', user: 'U' }, srv),
      (err) => {
        assert.match(err.message, /HTTP 401/);
        assert.ok(!err.message.includes(KEY), `报错泄露了 key：${err.message}`);
        return true;
      },
    );
  }
});

test('testConnection 永不抛出', async () => {
  const boom = { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } };
  const bad = await testConnection({ protocol: 'openai', baseUrl: 'http://127.0.0.1:1', apiKey: KEY, model: 'm', timeoutMs: 1500 }, boom);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /连不上模型服务/);
  const good = await testConnection({ protocol: 'openai', baseUrl: 'https://x.example/v1', apiKey: KEY, model: 'm' }, fakeFetch(() => ({ json: { model: 'm', choices: [{ message: { content: 'OK' } }] } })));
  assert.equal(good.ok, true);
  assert.equal(good.sample, 'OK');
  const incomplete = await testConnection({ protocol: 'openai', baseUrl: '', apiKey: '', model: '' });
  assert.equal(incomplete.ok, false);
  assert.match(incomplete.error, /配置不完整/);
});

test('scanSecrets 熔断：命中高危模式，且回显不含原文', () => {
  const hits = scanSecrets(`token=${KEY} and AKIAIOSFODNN7EXAMPLE and eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijk`);
  const kinds = hits.map((h) => h.kind);
  assert.ok(kinds.includes('openai-key') && kinds.includes('aws-access-key') && kinds.includes('jwt'), kinds.join(','));
  assert.ok(hits.every((h) => !h.snippet.includes(KEY.slice(8))), '不能回显密钥全文');
  assert.deepEqual(scanSecrets('改一下 tokenizer.ts 里的 password-strength 逻辑'), [], '普通句子不能误报');
  assert.deepEqual(scanSecrets('postgres://user@host/db'), [], '没有密码的连接串不报');
  assert.equal(scanSecrets('postgres://user:s3cret@host/db').length, 1);
});

test('redactPII 替换邮箱手机 IP，scrubSecrets 抹掉报错里的 key', () => {
  const r = redactPII('联系 zhang@example.com 或 13812345678，服务器 10.0.0.12');
  assert.equal(r.text, '联系 [邮箱] 或 [手机号]，服务器 [IP]');
  assert.deepEqual(r.counts, { email: 1, 'cn-phone': 1, ipv4: 1 });
  assert.equal(scrubSecrets(`bad ${KEY} here`), 'bad [已抹除] here');
  assert.equal(redactHome('/Users/me/code/x.py 和 /Users/me/y', '/Users/me'), '~/code/x.py 和 ~/y');
});

const MODS = [
  { key: 'erp@2026-09-07T08', title: 'ERP 行关闭同步 SRM', category: '代码', projectName: 'ERP_code', startTs: '2026-09-07T08:24:00Z', endTs: '2026-09-07T09:22:00Z', durationMin: 58, stats: { commits: 0, prompts: 2, files: 1, commands: 0 },
    items: [
      { kind: 'prompt', ts: '2026-09-07T08:24:00Z', sourceId: 'session:s1#6', label: '把 ERP 采购订单行关闭同步到 SRM' },
      { kind: 'prompt', ts: '2026-09-07T09:08:00Z', sourceId: 'session:s1#124', label: '金蝶只需要 FormId 就行了' },
      { kind: 'file', ts: '2026-09-07T09:20:00Z', sourceId: 'file:/x/CloseEntryToSrm.cs', label: 'CloseEntryToSrm.cs', path: '/x/CloseEntryToSrm.cs' },
    ] },
];

test('buildPrompt：每条证据带 [eN] 引用，refMap 可反查 source_id，不含 key', () => {
  const p = buildPrompt({ localDate: '2026-09-07', modules: MODS });
  assert.match(p.user, /\[e1\] \d\d:\d\d 提问：把 ERP 采购订单行关闭同步到 SRM/);
  assert.match(p.user, /\[e3\] \d\d:\d\d 改动文件：CloseEntryToSrm\.cs/);
  assert.equal(p.refMap.get('e1'), 'session:s1#6');
  assert.equal(p.refMap.get('e3'), 'file:/x/CloseEntryToSrm.cs');
  assert.equal(p.secretHits.length, 0);
  assert.ok(p.estTokens > 50);
  assert.ok(estimateTokens('中文中文中文') > estimateTokens('abcdef'), '中文每字 token 更多');
});

test('buildPrompt：证据里出现密钥 → writeWithAI 熔断，不发请求', async () => {
  const mods = [{ ...MODS[0], items: [...MODS[0].items, { kind: 'prompt', ts: '2026-09-07T09:30:00Z', sourceId: 'session:s1#130', label: `用这个 key：${KEY}` }] }];
  let called = false;
  await assert.rejects(
    writeWithAI({ ai: { protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: KEY, model: 'm' } }, { localDate: '2026-09-07', modules: mods }, { fetchImpl: async () => { called = true; throw new Error('不该到这'); } }),
    SecretsFoundError,
  );
  assert.equal(called, false, '熔断必须发生在 fetch 之前');
});

test('parseModelJson 容忍代码块与前后废话；entriesToJournal 把 ref 映射回 source_id，每个 entry 是一段散文', () => {
  const parsed = parseModelJson('好的，结果如下：\n```json\n{"summary":"今天主要在弄 ERP 同步。","entries":[{"topic":"ERP 同步","text":"把行关闭同步到 SRM，确认只需 FormId。","refs":["e1","e2"]},{"text":"编造的一句。","refs":["e99"]}]}\n```\n完毕。');
  const p = buildPrompt({ localDate: '2026-09-07', modules: MODS });
  const j = entriesToJournal(parsed, p.refMap, MODS);
  assert.equal(j.prose, true, 'AI 版是散文，渲染时不按模块分节');
  assert.equal(j.sections.length, 2, '一个 entry 一段');
  assert.equal(j.sections[0].title, 'ERP 同步', '段首小标题来自模型的 topic');
  assert.equal(j.sections[0].meta, null, '不再打印模块 meta');
  assert.deepEqual(j.sections[0].facts[0].source_ids, ['session:s1#6', 'session:s1#124']);
  assert.equal(j.sections[0].facts[0].confidence, 'confirmed');
  assert.equal(j.sections[1].title, '', 'topic 可省略');
  assert.equal(j.sections[1].facts[0].confidence, 'unverified', '引用不存在的 ref → unverified');
  assert.equal(j.summary.confidence, 'inferred');
  assert.throws(() => parseModelJson('没有 json'), /没有返回 JSON/);
  assert.throws(() => parseModelJson('{"foo":1}'), /缺少 overview/);
  const two = parseModelJson('{"overview":[{"text":"同步做完了","refs":["e1"]},"没引用的一条"],"entries":[]}');
  const j2 = entriesToJournal(two, p.refMap, MODS);
  assert.equal(j2.overview.length, 2, '第一层：总结性的结论');
  assert.equal(j2.overview[0].confidence, 'confirmed');
  assert.equal(j2.overview[1].confidence, 'unverified', '纯字符串也接受，但没引用就是 unverified');
});

test('buildPrompt：模板文字进 system，铁律不受模板影响；浏览带停留时长', () => {
  const template = { id: 'brief', name: '极简', text: '整篇不超过 150 字。' };
  const p = buildPrompt({ localDate: '2026-09-07', modules: [{ key: 'w@x', title: '浏览', category: '网页', projectName: '网页浏览', startTs: '2026-09-07T01:00:00Z', stats: {}, items: [{ kind: 'web', ts: '2026-09-07T01:00:00Z', label: 'DeepSeek 开放平台', host: 'platform.deepseek.com', secs: 750, sourceId: 'web:https://platform.deepseek.com/usage' }] }], template });
  assert.match(p.system, /模板「极简」/);
  assert.match(p.system, /整篇不超过 150 字/);
  assert.match(p.system, /铁律/);
  assert.match(p.user, /停留约 13 分钟/);
  assert.deepEqual(p.template, { id: 'brief', name: '极简' });
  const none = buildPrompt({ localDate: '2026-09-07', modules: MODS });
  assert.doesNotMatch(none.system, /模板「/);
});

test('writeWithAI 端到端（假服务）：返回带引用的日记结构', async () => {
  const srv = fakeFetch(() => ({ json: { model: 'm', choices: [{ message: { content: JSON.stringify({ summary: '概括', entries: [{ module: 'erp@2026-09-07T08', text: '同步行关闭', refs: ['e1'] }] }) } }], usage: { prompt_tokens: 100, completion_tokens: 20 } } }));
  const r = await writeWithAI({ ai: { protocol: 'openai', baseUrl: 'https://x.example/v1', apiKey: KEY, model: 'm' } }, { localDate: '2026-09-07', modules: MODS }, srv);
  assert.equal(r.journal.sections[0].facts[0].source_ids[0], 'session:s1#6');
  assert.equal(r.result.usage.input, 100);
  assert.ok(!JSON.stringify(srv.seen[0].body).includes('/x/'), '完整路径不进 prompt，只有文件名');
});

test('受管设备：managedDevice=true 时 writeWithAI 直接拒绝，fetch 不会被调用', async () => {
  let called = false;
  await assert.rejects(
    writeWithAI(
      { managedDevice: true, ai: { protocol: 'openai', baseUrl: 'https://x.example/v1', apiKey: KEY, model: 'm' } },
      { localDate: '2026-09-07', modules: MODS },
      { fetchImpl: async () => { called = true; throw new Error('不该到这'); } },
    ),
    ManagedDeviceError,
  );
  assert.equal(called, false, '受管设备上连请求都不能发出');
  assert.doesNotThrow(() => assertOutboundAllowed({ managedDevice: false }));
  assert.doesNotThrow(() => assertOutboundAllowed({}));
  assert.throws(() => assertOutboundAllowed({ managedDevice: true }), /managedDevice/);
});

test('buildPrompt：模块用了哪个 AI 工具写进 prompt，没有的不写', () => {
  const withTool = buildPrompt({ localDate: '2026-09-07', modules: [{ ...MODS[0], toolNames: ['Codex', 'Claude Code'] }] });
  assert.match(withTool.user, /标题：[^\n]+\n范围：[^\n]+\n用的 AI 工具：Codex、Claude Code\n\[e1\]/);
  const without = buildPrompt({ localDate: '2026-09-07', modules: MODS });
  assert.ok(!without.user.includes('用的 AI 工具'));
});

test('buildPrompt：模块的写法要求与整篇写作要求进 prompt，且同样过密钥熔断', () => {
  const p = buildPrompt({ localDate: '2026-09-07', modules: MODS, hints: { 'erp@2026-09-07T08': '只写结论，\n两句话', 'other@x': '不该出现' }, style: '口语一点' });
  assert.match(p.user, /整篇写作要求：口语一点/);
  assert.match(p.user, /## 模块 erp@2026-09-07T08\n标题：[^\n]+\n范围：[^\n]+\n用户对这段的补充说明（亲手写的，最可信，优先于下面的证据）：只写结论， 两句话\n\[e1\]/, '补充说明紧跟在范围之后、证据之前，标明是用户亲手写的，换行压成一行');
  assert.ok(!p.user.includes('不该出现'), '不在今天模块里的要求不发');
  assert.equal(p.hintCount, 1);
  assert.match(p.system, /补充说明/);
  const bad = buildPrompt({ localDate: '2026-09-07', modules: MODS, hints: { 'erp@2026-09-07T08': `用 ${KEY} 这个 key` } });
  assert.ok(bad.secretHits.some((h) => h.kind === 'openai-key'), '写法要求里的密钥同样熔断');
  const plain = buildPrompt({ localDate: '2026-09-07', modules: MODS });
  assert.ok(!plain.user.includes('补充说明') && !plain.user.includes('整篇写作要求'), '没写要求就一个字都不多');
  assert.equal(plain.hintCount, 0);
});

// ---- 2026-09-09：回复、浏览、大纲进 prompt ----

test('buildPrompt：助手回复缩进跟在提问后，浏览带搜索词与次数，文件带大纲，超出上限折叠', () => {
  const mods = [
    {
      key: 'erp@2026-09-07T08', title: 'ERP', category: '代码', projectName: 'ERP_code', startTs: '2026-09-07T08:24:00Z', endTs: '2026-09-07T09:22:00Z', durationMin: 58, stats: { commits: 0, prompts: 1, replies: 1, files: 1, commands: 0, searches: 1, pages: 0 },
      items: [
        { kind: 'prompt', ts: '2026-09-07T08:24:00Z', sourceId: 'session:s1#6', label: '把行关闭同步到 SRM' },
        { kind: 'reply', ts: '2026-09-07T08:40:00Z', sourceId: 'session-reply:s1#30', promptSourceId: 'session:s1#6', label: `已加 CloseEntryToSrm 插件，联系 ${os.homedir()} 下的脚本。` },
        { kind: 'action-search', ts: '2026-09-07T08:30:00Z', sourceId: 'session-action:s1#9:search:金蝶 FormId', label: '金蝶 FormId' },
        { kind: 'file', ts: '2026-09-07T09:20:00Z', sourceId: 'file:/x/周报.docx', label: '周报.docx', path: '/x/周报.docx', outline: ['本周进展', '风险'], outlineKind: 'headings' },
      ],
    },
    {
      key: 'web@2026-09-07T10', title: '浏览', category: '网页', projectName: '网页浏览', startTs: '2026-09-07T10:00:00Z', endTs: '2026-09-07T10:30:00Z', durationMin: 30, stats: { commits: 0, prompts: 0, files: 0, commands: 0, pages: 27 },
      items: [
        { kind: 'web', ts: '2026-09-07T10:00:00Z', sourceId: 'web:https://github.com/x', label: 'x repo', host: 'github.com', repeats: 3 },
        { kind: 'web', ts: '2026-09-07T10:01:00Z', sourceId: 'web:https://cn.bing.com/search?q=a', label: '搜索「a」', host: 'cn.bing.com', term: 'a', repeats: 1 },
        ...Array.from({ length: 25 }, (_, i) => ({ kind: 'web', ts: '2026-09-07T10:02:00Z', sourceId: `web:https://s.com/${i}`, label: `p${i}`, host: 's.com', repeats: 1 })),
      ],
    },
  ];
  const p = buildPrompt({ localDate: '2026-09-07', modules: mods });
  assert.match(p.user, /\[e1\] \d\d:\d\d 提问：把行关闭同步到 SRM\n  \[e2\] \d\d:\d\d 助手回复：已加 CloseEntryToSrm 插件，联系 ~ 下的脚本。/, '回复缩进、紧跟提问、家目录替换');
  assert.match(p.user, /联网搜索：金蝶 FormId/);
  assert.match(p.user, /改动文件：周报\.docx（标题：本周进展 ／ 风险）/);
  assert.match(p.user, /浏览：搜索「a」\n/, '浏览段里搜索排最前');
  assert.match(p.user, /浏览：x repo（github\.com，3 次）/);
  assert.match(p.user, /（另有 浏览 2 条 未列出）/, '超过 25 条折叠');
  assert.equal(p.refMap.get('e2'), 'session-reply:s1#30');
  assert.match(p.system, /助手回复/);
  assert.match(p.system, /浏览/);
});
