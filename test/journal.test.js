import { test } from 'node:test';
import assert from 'node:assert/strict';
import { journalFromModules, allFacts, renderJournalMarkdown, metaOf } from '../src/journal.js';
import { openDb, upsertEvidence, getDayState, setOverrides, setHint, logAiRun, aiUsageToday } from '../src/db.js';
import { validateReferences } from '../src/facts.js';
import { applySelection, matchesExcludeProjects } from '../src/day.js';

const mod = (over) => ({
  key: 'p@2026-09-07T08', title: '修同步', category: '代码', projectId: 'p', projectName: 'proj', startTs: '2026-09-07T08:00:00Z', endTs: '2026-09-07T09:00:00Z', durationMin: 60,
  stats: { commits: 1, prompts: 1, files: 1, commands: 0 }, sourceIds: ['commit:abc', 'session:s#1', 'file:/a/b.cs'], selected: true, score: 10,
  items: [
    { kind: 'commit', ts: '2026-09-07T08:00:00Z', sourceId: 'commit:abc', label: 'fix sync' },
    { kind: 'prompt', ts: '2026-09-07T08:10:00Z', sourceId: 'session:s#1', label: '为什么没同步' },
    { kind: 'file', ts: '2026-09-07T08:50:00Z', sourceId: 'file:/a/b.cs', label: 'b.cs', path: '/a/b.cs' },
  ],
  ...over,
});

test('规则版日记：重点 + 明细 + 被排除只写数量不写标题', () => {
  const mods = [mod(), mod({ key: 'q@x', title: '私事模块', projectName: 'private', selected: false, sourceIds: ['file:/p/1'], items: [{ kind: 'file', ts: '2026-09-07T10:00:00Z', sourceId: 'file:/p/1', label: '1.md' }] })];
  const j = journalFromModules(mods);
  assert.equal(j.sections.length, 1);
  assert.equal(j.highlights.length, 1);
  assert.equal(j.excludedCount, 1);
  const ev = new Map([
    ['commit:abc', { source_type: 'commit', source_ref: 'abc1234567', excerpt: 'fix sync', occurred_at: '2026-09-07T08:00:00.000Z' }],
    ['session:s#1', { source_type: 'session', source_ref: 's#1', excerpt: '为什么没同步', occurred_at: '2026-09-07T08:10:00.000Z' }],
    ['file:/a/b.cs', { source_type: 'file', source_ref: '/a/b.cs', path: '/a/b.cs', path_alias: 'b.cs', occurred_at: '2026-09-07T08:50:00.000Z' }],
  ]);
  const md = renderJournalMarkdown(j, { localDate: '2026-09-07', evidenceIndex: ev, footer: 'F', source: 'rules' });
  assert.match(md, /^# 2026-09-07/);
  assert.match(md, /## 今日重点/);
  assert.match(md, /### 修同步/);
  assert.match(md, /提交「fix sync」\[\^ev\d+\]/);
  assert.match(md, /改动文件：b\.cs\[\^ev\d+\]/);
  assert.match(md, /另有 1 个模块被排除/);
  assert.ok(!md.includes('私事模块'), '被排除模块的标题不能进落盘文件');
  assert.match(md, /\[\^ev1\]: commit `abc1234`/);
  assert.match(md, /文件 `b\.cs`（a\/）/);
});

test('规则版日记走引用校验：来源不存在会被降级', () => {
  const db = openDb(':memory:');
  upsertEvidence(db, { source_type: 'commit', source_ref: 'abc', occurred_at: '2026-09-07T08:00:00.000Z', local_date: '2026-09-07' });
  const j = journalFromModules([mod()]);
  const { downgraded } = validateReferences(db, allFacts(j), '2026-09-07');
  assert.ok(downgraded >= 1, 'session 与 file 证据没入库，对应条目必须降级');
  const md = renderJournalMarkdown(j, { localDate: '2026-09-07', evidenceIndex: new Map(), source: 'rules' });
  assert.match(md, /unverified/);
  db.close();
});

test('applySelection：默认 → 永久排除 → 手动覆盖，优先级递增', () => {
  const projects = [{ id: 'p', name: 'proj', rootPath: '/code/proj' }, { id: 'q', name: 'secret-client', rootPath: '/code/secret-client' }];
  const mods = [mod(), mod({ key: 'q@t', projectId: 'q', projectName: 'secret-client' }), mod({ key: 'b@t', selected: false, burst: true })];
  applySelection(mods, { 'b@t': true }, ['secret-client'], projects);
  assert.equal(mods[0].selected, true);
  assert.equal(mods[1].selected, false, '永久排除生效');
  assert.equal(mods[1].permanentlyExcluded, true);
  assert.equal(mods[2].selected, true, '用户手动把解压模块捞回来');
  assert.equal(mods[2].overridden, true);
  assert.equal(matchesExcludeProjects(mods[0], projects, ['/code/pro']), true, 'rootPath 子串也匹配');
});

test('applySelection 对同一批模块反复套用：默认值只记第一次，撤销覆盖后回到默认', () => {
  const projects = [{ id: 'p', name: 'proj', rootPath: '/code/proj' }];
  const mods = [mod(), mod({ key: 'b@t', selected: false, burst: true })];
  applySelection(mods, { 'p@2026-09-07T08': false, 'b@t': true }, [], projects);
  assert.equal(mods[0].selected, false);
  assert.equal(mods[1].selected, true);
  applySelection(mods, {}, [], projects); // 用户点了「恢复默认」
  assert.equal(mods[0].selected, true, '默认写进');
  assert.equal(mods[1].selected, false, '解压来的默认排除');
  assert.equal(mods[0].overridden, false);
  applySelection(mods, {}, ['proj'], projects);
  assert.equal(mods[0].selected, false, '第三次：永久排除生效');
  assert.equal(mods[0].defaultSelected, true, '默认值始终是第一次的');
});

test('metaOf：用了 AI 工具的模块带工具名，没有的不多一个字', () => {
  assert.equal(metaOf(mod({ toolNames: ['Codex', 'WorkBuddy'] })), 'proj ｜ Codex、WorkBuddy ｜ 16:00–17:00 ｜ 代码 ｜ 1 提交 · 1 提问 · 1 文件');
  assert.equal(metaOf(mod()), 'proj ｜ 16:00–17:00 ｜ 代码 ｜ 1 提交 · 1 提问 · 1 文件');
});

test('day_state overrides 三态持久化 + 兼容旧数组格式；ai_runs 账本', () => {
  const db = openDb(':memory:');
  assert.deepEqual(getDayState(db, '2026-09-07').overrides, {});
  setOverrides(db, '2026-09-07', { a: false, b: true, c: 'junk' });
  assert.deepEqual(getDayState(db, '2026-09-07').overrides, { a: false, b: true });
  db.prepare("UPDATE day_state SET excluded_json = '[\"x\",\"y\"]' WHERE local_date = ?").run('2026-09-07');
  assert.deepEqual(getDayState(db, '2026-09-07').overrides, { x: false, y: false }, '旧数组格式 = 全排除');
  logAiRun(db, { localDate: '2026-09-07', protocol: 'openai', model: 'm', inputTokens: 100, outputTokens: 20, latencyMs: 300, ok: true });
  logAiRun(db, { localDate: '2026-09-07', protocol: 'openai', model: 'm', ok: false, error: 'boom' });
  assert.deepEqual(aiUsageToday(db, '2026-09-07'), { calls: 1, input: 100, output: 20 }, '失败的不计入用量');
  db.close();
});

test('多日区间的引用校验：证据落在区间内任一天都算存在（week 不再整篇 unverified）', () => {
  const db = openDb(':memory:');
  upsertEvidence(db, { source_type: 'commit', source_ref: 'd1', occurred_at: '2026-09-06T08:00:00.000Z', local_date: '2026-09-06' });
  upsertEvidence(db, { source_type: 'commit', source_ref: 'd2', occurred_at: '2026-09-07T08:00:00.000Z', local_date: '2026-09-07' });
  const mk = () => [
    { text: 'a', source_ids: ['commit:d1'], confidence: 'confirmed' },
    { text: 'b', source_ids: ['commit:d2'], confidence: 'confirmed' },
  ];
  assert.equal(validateReferences(db, mk(), '2026-09-07').downgraded, 1, '只查末日：前一天的证据会被误判缺失');
  assert.equal(validateReferences(db, mk(), ['2026-09-06', '2026-09-07']).downgraded, 0, '按区间内全部日期查：都存在');
  assert.equal(validateReferences(db, mk(), []).downgraded, 2, '空日期列表 = 什么都不存在');
  db.close();
});

test('renderJournalMarkdown 支持自定义标题（周汇总）', () => {
  const md = renderJournalMarkdown(
    { highlights: [], sections: [], excludedCount: 0 },
    { localDate: '2026-09-08', heading: '2026-09-02 ～ 2026-09-08（7 天汇总）', evidenceIndex: new Map(), source: 'rules' },
  );
  assert.match(md, /^# 2026-09-02 ～ 2026-09-08（7 天汇总）\n/);
  assert.match(md, /这段时间没有可写进日记的内容/);
});

test('每个模块可以存一段给模型的写法要求；改选择不会抹掉它；空串即删除', () => {
  const db = openDb(':memory:');
  assert.deepEqual(getDayState(db, '2026-09-08').hints, {});
  assert.deepEqual(setHint(db, '2026-09-08', 'p@2026-09-08T08', ' 只写结论 '), { 'p@2026-09-08T08': '只写结论' });
  setHint(db, '2026-09-08', 'q@x', '合并到概括');
  setOverrides(db, '2026-09-08', { 'q@x': false });
  assert.deepEqual(getDayState(db, '2026-09-08').hints, { 'p@2026-09-08T08': '只写结论', 'q@x': '合并到概括' }, '改选择不影响写法要求');
  assert.deepEqual(getDayState(db, '2026-09-08').overrides, { 'q@x': false }, '写法要求也不影响选择');
  assert.deepEqual(setHint(db, '2026-09-08', 'q@x', ''), { 'p@2026-09-08T08': '只写结论' });
  assert.equal(setHint(db, '2026-09-08', 'p@2026-09-08T08', 'x'.repeat(5000))['p@2026-09-08T08'].length, 2000, '超长截断');
  db.close();
});

// ---- 2026-09-09：规则版日记里的回复、大纲、浏览 ----

test('规则版日记：回复缩进在提问下，带大纲的文档单列一行，浏览段搜索在前', () => {
  const mods = [
    mod({
      stats: { commits: 0, prompts: 1, replies: 1, files: 1, commands: 0, searches: 1 },
      sourceIds: ['session:s#1', 'session-reply:s#9', 'file:/a/周报.docx', 'session-action:s#5:search:金蝶'],
      items: [
        { kind: 'prompt', ts: '2026-09-07T08:10:00Z', sourceId: 'session:s#1', label: '为什么没同步' },
        { kind: 'reply', ts: '2026-09-07T08:20:00Z', sourceId: 'session-reply:s#9', promptSourceId: 'session:s#1', label: '因为 FormId 没传，已补上。' },
        { kind: 'action-search', ts: '2026-09-07T08:12:00Z', sourceId: 'session-action:s#5:search:金蝶', label: '金蝶 FormId' },
        { kind: 'file', ts: '2026-09-07T08:50:00Z', sourceId: 'file:/a/周报.docx', label: '周报.docx', path: '/a/周报.docx', outline: ['本周进展', '风险', '下周', '再一条', '第五条'], outlineKind: 'headings' },
      ],
    }),
    mod({
      key: 'web@x', title: '浏览 3 个页面', category: '网页', projectName: '网页浏览', projectId: 'web',
      stats: { commits: 0, prompts: 0, files: 0, commands: 0, pages: 3 }, sourceIds: ['web:a', 'web:b', 'web:c'],
      items: [
        { kind: 'web', ts: '2026-09-07T10:00:00Z', sourceId: 'web:a', label: 'GitHub 首页', host: 'github.com', repeats: 2 },
        { kind: 'web', ts: '2026-09-07T10:01:00Z', sourceId: 'web:b', label: '搜索「x」', host: 'cn.bing.com', term: 'x', repeats: 1 },
        { kind: 'web', ts: '2026-09-07T10:02:00Z', sourceId: 'web:c', label: '文档', host: 'learn.microsoft.com', repeats: 1 },
      ],
    }),
  ];
  const j = journalFromModules(mods);
  const texts = j.sections[0].facts.map((f) => `${f.depth}|${f.text}`);
  assert.ok(texts.includes('0|提问：为什么没同步'));
  assert.equal(texts[texts.indexOf('0|提问：为什么没同步') + 1], '1|回复：因为 FormId 没传，已补上。', '回复紧跟提问、缩进一级');
  assert.ok(texts.includes('1|周报.docx（标题：本周进展 ／ 风险 ／ 下周 ／ 再一条 …）'), texts.join('\n'));
  assert.ok(texts.includes('0|联网搜索：「金蝶 FormId」'));
  const web = j.sections[1].facts.map((f) => f.text);
  assert.deepEqual(web, ['搜索「x」', '浏览：GitHub 首页（github.com，2 次）', '浏览：文档（learn.microsoft.com）']);
  assert.match(j.sections[1].meta, /3 页面/);
  const md = renderJournalMarkdown(j, {
    localDate: '2026-09-07',
    evidenceIndex: new Map([
      ['session-reply:s#9', { source_type: 'session-reply', source_ref: 's#9', excerpt: '因为 FormId 没传，已补上。', occurred_at: '2026-09-07T08:20:00.000Z' }],
      ['web:a', { source_type: 'web', source_ref: 'https://github.com/', path: 'https://github.com/', path_alias: 'github.com', excerpt: 'GitHub 首页｜2 次｜Edge', occurred_at: '2026-09-07T10:00:00.000Z' }],
      ['file:/a/周报.docx', { source_type: 'file', source_ref: '/a/周报.docx', path: '/a/周报.docx', path_alias: '周报.docx', excerpt: '标题：本周进展 ／ 风险', occurred_at: '2026-09-07T08:50:00.000Z' }],
    ]),
    source: 'rules',
  });
  assert.match(md, /  - 回复：因为 FormId 没传，已补上。\[\^ev\d+\]/);
  assert.match(md, /会话 `s` 第 9 条消息的回复/);
  assert.match(md, /网页「GitHub 首页」（github\.com），2 次，Edge，首次打开 2026-09-07T10:00:00Z：<https:\/\/github\.com\/>/);
  assert.match(md, /文件 `周报\.docx`（a\/），改于 [^，]+，标题：本周进展 ／ 风险/);
});

test('AI 版是散文：不按模块分节、不打印 meta，小标题加粗放段首，脚注照常', () => {
  const journal = {
    prose: true,
    summary: { text: '今天主要在修同步。', source_ids: ['commit:abc'], confidence: 'inferred', depth: 0 },
    highlights: [],
    sections: [
      { key: 'p1', title: '同步问题', meta: null, facts: [{ text: '上午让 AI 查为什么没同步，它改了 b.cs。', source_ids: ['session:s#1', 'file:/a/b.cs'], confidence: 'confirmed', depth: 0 }] },
      { key: 'p2', title: '', meta: null, facts: [{ text: '顺手提交了修复。', source_ids: ['commit:abc'], confidence: 'confirmed', depth: 0 }] },
    ],
    excludedCount: 1,
  };
  const evidenceIndex = new Map([
    ['commit:abc', { source_type: 'commit', source_ref: 'abc1234', excerpt: 'fix sync', occurred_at: '2026-09-07T08:00:00Z' }],
    ['session:s#1', { source_type: 'session', source_ref: 's#1', excerpt: '为什么没同步', occurred_at: '2026-09-07T08:10:00Z' }],
    ['file:/a/b.cs', { source_type: 'file', source_ref: '/a/b.cs', path: '/a/b.cs', path_alias: 'b.cs', excerpt: '12 bytes｜新出现', occurred_at: '2026-09-07T08:50:00Z' }],
  ]);
  const md = renderJournalMarkdown(journal, { localDate: '2026-09-07', evidenceIndex, footer: 'f', source: 'ai' });
  assert.doesNotMatch(md, /## 明细/);
  assert.doesNotMatch(md, /^### /m);
  assert.doesNotMatch(md, /^_.*_$/m, '没有模块 meta 行');
  assert.match(md, /^\*\*同步问题\*\* 上午让 AI 查为什么没同步，它改了 b\.cs。\[\^ev2\]\[\^ev3\]$/m);
  assert.match(md, /^顺手提交了修复。\[\^ev1\]$/m, '没有 topic 就不加粗前缀');
  assert.match(md, /另有 1 个模块被排除/);
  assert.match(md, /\[\^ev3\]: 文件 `b\.cs`（a\/），出现于 2026-09-07T08:50:00Z，新出现（创建于当天）/);
  assert.match(md, /由 AI 依据证据撰写：2 条/);
});

// ---- 2026-09-12：两层 AI 日记、干净落盘、英文标题 ----
test('AI 版两层：今日概览是列表、过程是段落；stripAnnotations 去掉上标 / 脚注 / 统计行；英文标题', async () => {
  const { stripAnnotations } = await import('../src/journal.js');
  const journal = {
    prose: true,
    overview: [{ text: '改名做完了。', source_ids: ['commit:abc'], confidence: 'confirmed', depth: 0 }, { text: '没引用的一条。', source_ids: [], confidence: 'unverified', depth: 0 }],
    highlights: [],
    sections: [{ key: 'p1', title: '改名', meta: null, facts: [{ text: '08:20 我让 Codex 改名。', source_ids: ['commit:abc'], confidence: 'confirmed', depth: 0 }] }],
    excludedCount: 1,
  };
  const evidenceIndex = new Map([['commit:abc', { source_type: 'commit', source_ref: 'abc1234', excerpt: 'rename', occurred_at: '2026-09-12T00:20:00Z' }]]);
  const md = renderJournalMarkdown(journal, { localDate: '2026-09-12', evidenceIndex, footer: 'f', source: 'ai' });
  assert.match(md, /^## 今日概览\n\n- 改名做完了。\[\^ev1\]\n- 没引用的一条。 `unverified`（无法关联来源，请确认或删除）\n\n## 过程\n\n\*\*改名\*\* 08:20 我让 Codex 改名。\[\^ev1\]/m);
  const clean = stripAnnotations(md);
  assert.equal(clean, '# 2026-09-12\n\n## 今日概览\n\n- 改名做完了。\n- 没引用的一条。\n\n## 过程\n\n**改名** 08:20 我让 Codex 改名。\n', clean);
  assert.equal(allFacts(journal).length, 3, 'overview 也参与引用校验');
  const en = renderJournalMarkdown(journal, { localDate: '2026-09-12', evidenceIndex, source: 'ai', lang: 'en' });
  assert.match(en, /## Overview[\s\S]*## Notes/);
});
