import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModules, splitByGap, toTitle, scoreOf, timelineOf, DEFAULT_GAP_MINUTES, isBurst, dedupeItems, toolsOf } from '../src/modules.js';

const T = (h, m = 0) => `2026-09-05T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;

test('toTitle 取第一句并截断', () => {
  assert.equal(toTitle('把周报按 PDCA 重排。然后同步到 OA'), '把周报按 PDCA 重排');
  assert.equal(toTitle('  、，这是我今天上午做的事情'), '这是我今天上午做的事情');
  assert.equal(toTitle('一'.repeat(50)).length, 33, '32 字 + 省略号');
  assert.equal(toTitle(''), '');
  assert.equal(toTitle(null), '');
});

test('splitByGap 按空隙切块', () => {
  const items = [{ ts: T(9) }, { ts: T(9, 30) }, { ts: T(14) }, { ts: T(14, 10) }];
  const blocks = splitByGap(items, 90);
  assert.equal(blocks.length, 2, '上午一块、下午一块');
  assert.deepEqual(blocks.map((b) => b.length), [2, 2]);
  // 间隔放大到 8 小时就并成一块
  assert.equal(splitByGap(items, 8 * 60).length, 1);
});

test('scoreOf：有提交的权重高于纯文件改动，且文件数是饱和的', () => {
  const commitHeavy = scoreOf({ commits: 2, prompts: 0, commands: 0, files: 3 }, 30);
  const fileOnly = scoreOf({ commits: 0, prompts: 0, commands: 0, files: 15 }, 30);
  assert.ok(commitHeavy > fileOnly, `2 提交+3 文件(${commitHeavy}) 应高于 15 文件(${fileOnly})`);

  // 关键：文件数翻十倍，权重不能翻十倍，否则 QQ 那 62 个 .db-shm 会压过真实工作
  const few = scoreOf({ commits: 0, prompts: 0, commands: 0, files: 6 }, 0);
  const many = scoreOf({ commits: 0, prompts: 0, commands: 0, files: 60 }, 0);
  assert.ok(many < few * 4, `60 文件(${many}) 不该接近 6 文件(${few}) 的十倍`);

  // 一条提问的分量要高于一个文件被碰过
  assert.ok(scoreOf({ commits: 0, prompts: 1, commands: 0, files: 0 }, 0) > scoreOf({ commits: 0, prompts: 0, commands: 0, files: 1 }, 0) - 0.1);

  // 持续时间加成最多翻倍
  assert.ok(scoreOf({ commits: 1, prompts: 0, commands: 0, files: 0 }, 600) <= 6 * 2);
});

function makeInput(overrides = {}) {
  return {
    projects: [{ id: 'demo', name: 'demo', rootPath: '/tmp/demo' }],
    gitByProject: new Map(),
    sessionsByProject: new Map(),
    filesByProject: new Map(),
    nowIso: T(23),
    ...overrides,
  };
}

test('模块带上出现过的 AI 工具：按出现次数排、显示名来自注册表、没有会话的模块没有', () => {
  const input = makeInput({
    sessionsByProject: new Map([
      [
        'demo',
        [
          { sessionId: 's1', providerId: 'codex', title: null, prompts: [{ index: 1, text: '看看这个报错', ts: T(9) }], actions: [{ index: 2, kind: 'file', value: '/tmp/demo/a.js', ts: T(9, 1) }], replies: [{ index: 3, text: '修好了', ts: T(9, 2), promptIndex: 1 }] },
          { sessionId: 's2', providerId: 'claude-code', title: null, prompts: [{ index: 1, text: '再看一眼', ts: T(9, 20) }], actions: [] },
          { sessionId: 's3', providerId: 'workbuddy', title: null, prompts: [{ index: 1, text: '写个周报', ts: T(9, 30) }], actions: [] },
        ],
      ],
    ]),
    filesByProject: new Map([['demo', [{ path: '/tmp/demo/b.md', mtime: T(9, 40) }]]]),
  });
  const mods = buildModules(input, { gapMinutes: DEFAULT_GAP_MINUTES });
  assert.equal(mods.length, 1);
  assert.deepEqual(mods[0].tools, ['codex', 'claude-code', 'workbuddy'], 'codex 出现 3 次排第一');
  assert.deepEqual(mods[0].toolNames, ['Codex', 'Claude Code', 'WorkBuddy']);
  const first = (kind) => mods[0].items.find((i) => i.kind === kind);
  assert.equal(first('prompt').provider, 'codex', '提问带工具');
  assert.equal(first('action-file').provider, 'codex', 'AI 改的文件带工具');
  assert.equal(first('reply').provider, 'codex', '回复带工具');
  assert.deepEqual(mods[0].items.filter((i) => i.kind === 'prompt').map((i) => i.provider), ['codex', 'claude-code', 'workbuddy']);
  assert.equal(first('file').provider, undefined, '文件扫描来的没有工具');
  assert.deepEqual(toolsOf([{ kind: 'file' }, { kind: 'commit' }]), { tools: [], toolNames: [] });
  assert.deepEqual(toolsOf([{ kind: 'prompt', provider: 'nobody-knows' }]).toolNames, ['nobody-knows'], '注册表里没有的 id 原样给');
  const noAi = buildModules(makeInput({ filesByProject: new Map([['demo', [{ path: '/tmp/demo/a.js', mtime: T(9) }, { path: '/tmp/demo/b.js', mtime: T(9, 1) }, { path: '/tmp/demo/c.js', mtime: T(9, 2) }]]]) }), {});
  assert.deepEqual(noAi[0].tools, []);
  assert.deepEqual(noAi[0].toolNames, []);
});

test('同一项目里间隔超过阈值会切成两个模块', () => {
  const input = makeInput({
    sessionsByProject: new Map([
      [
        'demo',
        [
          {
            sessionId: 's1',
            providerId: 'codex',
            title: null,
            prompts: [
              { index: 1, text: '上午核对西南电池的出勤数据', ts: T(9) },
              { index: 2, text: '下午把周报按 PDCA 重排', ts: T(15) },
            ],
            actions: [],
          },
        ],
      ],
    ]),
  });
  const mods = buildModules(input, { gapMinutes: DEFAULT_GAP_MINUTES });
  assert.equal(mods.length, 2);
  assert.deepEqual(mods.map((m) => m.title).sort(), ['上午核对西南电池的出勤数据', '下午把周报按 PDCA 重排'].sort());
  assert.ok(mods.every((m) => m.selected === true));
});

test('commit 优先当标题，类别判为代码', () => {
  const input = makeInput({
    gitByProject: new Map([
      [
        'demo',
        [
          {
            repo: '/tmp/demo',
            commits: [
              { hash: 'h1', message: '修好扫描器的时间窗口', committedAt: T(10), files: ['src/a.ts'], additions: 3, deletions: 1 },
              { hash: 'h2', message: '补测试', committedAt: T(10, 20), files: ['test/a.test.ts'], additions: 9, deletions: 0 },
            ],
            dirty: [],
          },
        ],
      ],
    ]),
  });
  const mods = buildModules(input);
  assert.equal(mods.length, 1);
  assert.equal(mods[0].title, '修好扫描器的时间窗口（等 2 个提交）');
  assert.equal(mods[0].category, '代码');
  assert.equal(mods[0].stats.commits, 2);
});

test('只有零星文件改动的项目并入杂项，且默认不写进日记', () => {
  const input = makeInput({
    projects: [
      { id: 'demo', name: 'demo', rootPath: '/tmp/demo' },
      { id: 'junk', name: 'junk', rootPath: '/tmp/junk' },
    ],
    filesByProject: new Map([
      ['junk', [{ path: '/tmp/junk/setting.json', mtime: T(20) }, { path: '/tmp/junk/config.json', mtime: T(20, 5) }]],
    ]),
  });
  const mods = buildModules(input);
  const misc = mods.find((m) => m.id === 'mod:misc');
  assert.ok(misc, '应该有杂项模块');
  assert.equal(misc.selected, false, '杂项默认排除');
  assert.equal(misc.stats.files, 2);
  assert.ok(misc.why.includes('默认排除'));
});

test('未提交改动用文件真实 mtime，不再全堆在运行那一刻', () => {
  const input = makeInput({
    gitByProject: new Map([
      ['demo', [{ repo: '/tmp/demo', commits: [], dirty: [{ status: 'M', path: 'src/a.ts', mtime: T(9) }, { status: 'M', path: 'src/b.ts', mtime: T(9, 10) }] }]],
    ]),
  });
  const items = timelineOf(input.projects[0], input);
  assert.deepEqual(items.map((i) => i.ts), [T(9), T(9, 10)]);
  assert.ok(items.every((i) => i.ts !== input.nowIso));
});

test('解压/复制：一批文件几秒内同时出现，判为「新增项目」，默认写进日记但权重很低', () => {
  const t0 = Date.parse('2026-09-07T05:00:00.000Z');
  const hits = Array.from({ length: 12 }, (_, i) => ({
    path: `/x/MizTrace-main/f${i}.md`,
    mtime: new Date(t0 + i * 200).toISOString(), // 12 个文件 2.4 秒内
    size: 1,
    created: true,
  }));
  const project = { id: 'miztrace', name: 'MizTrace-main', rootPath: '/x/MizTrace-main' };
  const mods = buildModules(
    {
      projects: [project],
      gitByProject: new Map(),
      sessionsByProject: new Map(),
      filesByProject: new Map([['miztrace', hits]]),
      nowIso: new Date().toISOString(),
    },
    {},
  );
  assert.equal(mods.length, 1);
  assert.equal(mods[0].burst, true);
  assert.equal(mods[0].selected, true, '今天下载了一个新项目值得在日记里占一句');
  assert.ok(mods[0].score <= 1, '但权重压到最低，模型只会一句带过');
  assert.equal(mods[0].category, '杂项');
  assert.match(mods[0].title, /新增项目 MizTrace-main（12 个文件）/);
  assert.equal(mods[0].stats.created, 12, '记下有多少是新出现的');
  assert.equal(mods[0].items.length, 12, '模块要带 items 供前端展开');
  assert.equal(mods[0].items[0].label, 'f0.md', 'items 里的文件只留 basename');
  assert.equal(mods[0].items[0].created, true);
});

test('今天 clone 的仓库：没有 commit 也没有改动，仍然成为一个模块', () => {
  const input = makeInput({
    gitByProject: new Map([
      ['demo', [{ repo: '/tmp/demo', branch: 'main', commits: [], dirty: [], arrival: { at: T(9, 12), remote: 'github.com/MIZHOUCL/MizTrace' } }]],
    ]),
  });
  const mods = buildModules(input, {});
  assert.equal(mods.length, 1);
  assert.equal(mods[0].selected, true);
  assert.equal(mods[0].category, '代码');
  assert.equal(mods[0].title, 'clone 了 demo（github.com/MIZHOUCL/MizTrace）');
  assert.equal(mods[0].stats.clones, 1);
  assert.equal(mods[0].items[0].kind, 'clone');
  assert.equal(mods[0].items[0].remote, 'github.com/MIZHOUCL/MizTrace');
  assert.equal(mods[0].sourceIds[0], 'clone:/tmp/demo');
});

test('终端命令：按目录归到项目，纯命令的模块归「终端」类别，标题按命令词概述', () => {
  const cmds = [
    { ts: T(10, 0), cwd: '/tmp/demo', cmd: 'npm test', id: 'a1' },
    { ts: T(10, 1), cwd: '/tmp/demo', cmd: 'npm test', id: 'a2' },
    { ts: T(10, 5), cwd: '/tmp/demo', cmd: 'git status', id: 'a3' },
    { ts: T(10, 6), cwd: '/tmp/demo', cmd: 'git push', id: 'a4' },
  ];
  const input = makeInput({ shellByProject: new Map([['demo', cmds]]) });
  const mods = buildModules(input, {});
  assert.equal(mods.length, 1);
  assert.equal(mods[0].category, '终端');
  assert.equal(mods[0].selected, true);
  assert.equal(mods[0].stats.shell, 3, '统计在去重之后：一字不差的命令算一条');
  assert.match(mods[0].title, /^终端：npm、git 3 条命令$/);
  const shellItems = mods[0].items.filter((i) => i.kind === 'shell');
  assert.equal(shellItems.length, 3, '一字不差的命令只留一条');
  assert.equal(shellItems[0].repeats, 2);
  assert.equal(shellItems[0].cwd, '/tmp/demo');
});

test('人手改动：文件分散在一小时内，不算解压，正常进日记', () => {
  const t0 = Date.parse('2026-09-07T05:00:00.000Z');
  const hits = Array.from({ length: 10 }, (_, i) => ({
    path: `/x/proj/f${i}.py`,
    mtime: new Date(t0 + i * 5 * 60_000).toISOString(), // 每 5 分钟一个
    size: 1,
  }));
  const project = { id: 'proj', name: 'proj', rootPath: '/x/proj' };
  const mods = buildModules(
    { projects: [project], gitByProject: new Map(), sessionsByProject: new Map(), filesByProject: new Map([['proj', hits]]), nowIso: new Date().toISOString() },
    {},
  );
  assert.equal(mods.length, 1);
  assert.equal(mods[0].burst, undefined);
  assert.equal(mods[0].selected, true);
});

test('isBurst 边界：有提问就不算解压，文件太少也不算', () => {
  const t = '2026-09-07T05:00:00.000Z';
  const files = Array.from({ length: 10 }, (_, i) => ({ kind: 'file', ts: t, label: `/a/f${i}` }));
  assert.equal(isBurst(files, { prompts: 0, commits: 0, commands: 0, files: 10 }), true);
  assert.equal(isBurst([...files, { kind: 'prompt', ts: t, label: '改一下' }], { prompts: 1, commits: 0, commands: 0, files: 10 }), false);
  assert.equal(isBurst(files.slice(0, 5), { prompts: 0, commits: 0, commands: 0, files: 5 }), false);
});

test('同一模块内一字不差的提问只留一条，其余来源挂在 altSourceIds', () => {
  const t = (m) => `2026-09-07T05:${String(m).padStart(2, '0')}:00.000Z`;
  const items = [
    { kind: 'prompt', ts: t(0), label: 'Continue from where you left off.', sourceId: 'session:a#1' },
    { kind: 'prompt', ts: t(1), label: 'Continue from where you left off.', sourceId: 'session:b#1' },
    { kind: 'prompt', ts: t(2), label: ' Continue from where you left off. ', sourceId: 'session:c#1' },
    { kind: 'prompt', ts: t(3), label: '另一句', sourceId: 'session:a#5' },
    { kind: 'file', ts: t(4), label: '/x/a.md', sourceId: 'file:/x/a.md' },
    { kind: 'file', ts: t(5), label: '/x/a.md', sourceId: 'file:/x/a.md' },
  ];
  const out = dedupeItems(items);
  assert.equal(out.filter((i) => i.kind === 'prompt').length, 2);
  assert.equal(out[0].repeats, 3);
  assert.deepEqual(out[0].altSourceIds, ['session:b#1', 'session:c#1']);
  assert.equal(out.filter((i) => i.kind === 'file').length, 2, '文件不在这里去重（上游已按 sourceId 去重）');
  assert.equal(items[0].altSourceIds, undefined, '不能改动传入的对象');
});

test('以对话为主、几乎不碰文件的模块归为「AI会话」，而不是按一两个文件的扩展名乱定类别', () => {
  const t = (m) => `2026-09-07T05:${String(m).padStart(2, '0')}:00.000Z`;
  const project = { id: 'p', name: 'p', rootPath: '/x/p' };
  const session = {
    providerId: 'claude-code', sessionId: 's1', title: '聊需求', cwd: '/x/p', firstTs: t(0),
    prompts: [1, 2, 3, 4].map((i) => ({ index: i, text: `问题 ${i}`, ts: t(i), localDate: '2026-09-07' })),
    actions: [{ index: 9, kind: 'file', value: '/x/p/data.json', ts: t(9) }],
  };
  const mods = buildModules(
    { projects: [project], gitByProject: new Map(), sessionsByProject: new Map([['p', [session]]]), filesByProject: new Map(), nowIso: t(10) },
    {},
  );
  assert.equal(mods.length, 1);
  assert.equal(mods[0].category, 'AI会话', `实际：${mods[0].category}`);
});

// ---- 2026-09-09：回复、浏览、大纲 ----

test('回复永远跟着提问走：中间隔了两小时也不会被切成孤块', () => {
  const items = [
    { ts: T(9), kind: 'prompt', label: '跑一遍全量迁移', sourceId: 'session:s#1' },
    { ts: T(11, 10), kind: 'reply', label: '迁移跑完了，共 3 张表。', sourceId: 'session-reply:s#40', promptSourceId: 'session:s#1' },
    { ts: T(15), kind: 'prompt', label: '下午另一件事', sourceId: 'session:s#41' },
  ];
  const blocks = splitByGap(items, 90);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0].map((i) => i.kind), ['prompt', 'reply']);
});

test('模块条目带回复与大纲；有大纲的单个文档用文档标题当模块标题', async () => {
  const { buildModules } = await import('../src/modules.js');
  const project = { id: 'p', name: 'p', rootPath: '/x/p' };
  const session = {
    providerId: 'codex', sessionId: 's1', title: null, cwd: '/x/p', firstTs: T(9),
    prompts: [{ index: 1, text: '把行关闭同步到 SRM', ts: T(9), localDate: '2026-09-05' }],
    replies: [{ index: 7, text: '已加上 CloseEntryToSrm 插件。', ts: T(9, 20), promptIndex: 1, localDate: '2026-09-05' }],
    actions: [{ index: 5, kind: 'search', value: '金蝶 FormId', ts: T(9, 5) }],
  };
  const hits = [{ path: '/x/p/周报.docx', mtime: T(9, 30), size: 1, outline: { kind: 'headings', items: ['本周进展', '风险'] } }];
  const mods = buildModules({ projects: [project], gitByProject: new Map(), sessionsByProject: new Map([['p', [session]]]), filesByProject: new Map([['p', hits]]), nowIso: T(10) }, {});
  assert.equal(mods.length, 1);
  const m = mods[0];
  assert.equal(m.stats.replies, 1);
  assert.equal(m.stats.searches, 1);
  const reply = m.items.find((i) => i.kind === 'reply');
  assert.equal(reply.promptSourceId, 'session:s1#1');
  assert.equal(m.items.find((i) => i.kind === 'action-search').label, '金蝶 FormId');
  const file = m.items.find((i) => i.kind === 'file');
  assert.deepEqual(file.outline, ['本周进展', '风险']);
  assert.equal(file.outlineKind, 'headings');
  assert.ok(m.sourceIds.includes('session-reply:s1#7'));

  const docOnly = buildModules({ projects: [project], gitByProject: new Map(), sessionsByProject: new Map(), filesByProject: new Map([['p', [...hits, { path: '/x/p/附件.xlsx', mtime: T(9, 31), size: 1 }, { path: '/x/p/c.md', mtime: T(9, 32), size: 1 }]]]), nowIso: T(10) }, {});
  assert.equal(docOnly[0].title, '本周进展 等 3 个文件', '文件不多且带大纲时，用大纲第一条当标题');
  assert.equal(docOnly[0].category, '文档');
});

test('浏览记录自成「网页浏览」项目，按 30 分钟切段，零散的并成一组并默认排除', async () => {
  const { webModules } = await import('../src/modules.js');
  const visit = (h, m, url, title, extra = {}) => ({ url, host: new URL(url).hostname, title, term: null, ts: T(h, m), secs: 10, ...extra });
  const pages = [
    visit(9, 0, 'https://cn.bing.com/search?q=x', '搜索「deepseek harness」', { term: 'deepseek harness' }),
    visit(9, 5, 'https://github.com/a', 'a'),
    visit(9, 10, 'https://learn.microsoft.com/b', 'b'),
    visit(9, 11, 'https://learn.microsoft.com/b', 'b'),
    visit(9, 14, 'https://learn.microsoft.com/b', 'b'),
    visit(9, 12, 'https://learn.microsoft.com/c', 'c'),
    visit(14, 0, 'https://x.com/lonely', '顺手看了一眼'),
    visit(16, 0, 'https://y.com/another', '又一个'),
    // 早上看过的页面下午又开一次：是下午那一段的事，不能把早上那段拉长到下午
    visit(16, 1, 'https://github.com/a', 'a'),
  ];
  const mods = webModules(pages, { gapMinutes: 30, localDate: '2026-09-05' });
  assert.equal(mods.length, 2);
  assert.equal(mods[0].category, '网页');
  assert.equal(mods[0].projectId, 'web');
  assert.equal(mods[0].stats.pages, 4);
  assert.equal(mods[0].stats.sites, 3);
  assert.match(mods[0].title, /搜索「deepseek harness」/);
  assert.equal(mods[0].selected, true);
  assert.equal(mods[0].items[0].term, 'deepseek harness');
  assert.equal(mods[0].items[2].repeats, 3, '同一段里同一页看了三次');
  assert.equal(mods[0].endTs, T(9, 14), '段的结束时间取段内末次访问，不被下午的重访拉长');
  assert.ok(mods[0].score > 0);
  assert.equal(mods[1].id, 'mod:web-misc');
  assert.equal(mods[1].selected, false);
  assert.equal(mods[1].stats.pages, 3, '零散的三次：x.com、y.com、下午重开的 github');
  assert.deepEqual(webModules([], {}), []);
  const all = buildModules({ projects: [], gitByProject: new Map(), sessionsByProject: new Map(), filesByProject: new Map(), nowIso: T(20), webVisits: pages }, { webGapMinutes: 30, localDate: '2026-09-05' });
  assert.equal(all.length, 2, 'buildModules 把浏览段并进结果');
});

test('dedupeItems：提问被合并后，它的回复改挂到留下的那条提问上', () => {
  const t = (m) => `2026-09-07T05:${String(m).padStart(2, '0')}:00.000Z`;
  const out = dedupeItems([
    { kind: 'prompt', ts: t(0), label: '继续', sourceId: 'session:a#1' },
    { kind: 'reply', ts: t(1), label: '好的，继续。', sourceId: 'session-reply:a#2', promptSourceId: 'session:a#1' },
    { kind: 'prompt', ts: t(2), label: '继续', sourceId: 'session:b#1' },
    { kind: 'reply', ts: t(3), label: '这次做完了。', sourceId: 'session-reply:b#2', promptSourceId: 'session:b#1' },
  ]);
  assert.deepEqual(out.map((i) => i.kind), ['prompt', 'reply', 'reply']);
  assert.equal(out[2].promptSourceId, 'session:a#1');
});

// ---- 2026-09-12 ----
test('只改了一份文档 / 表格的项目不算零散改动：自成模块、默认写进日记', () => {
  const input = makeInput({
    projects: [{ id: 'rep', name: 'reports', rootPath: '/tmp/reports' }],
    filesByProject: new Map([['rep', [{ path: '/tmp/reports/周报9.12.xlsx', mtime: T(15) }]]]),
  });
  const mods = buildModules(input);
  const m = mods.find((x) => x.projectId === 'rep');
  assert.ok(m, '表格应该自成模块');
  assert.equal(m.selected, true);
  assert.equal(m.category, '数据');
  assert.ok(!mods.some((x) => x.id === 'mod:misc'), '不该进杂项');
});

test('给泡泡补的图挂到那个模块上，手记模块不显示它；浏览段的键精确到分钟，撞车加 #2', async () => {
  const { attachHintImages, dedupeKeys, notesModules } = await import('../src/modules.js');
  const visits = [1, 2, 3].map((i) => ({ ts: `2026-09-07T02:0${i}:00.000Z`, url: `https://x.com/${i}`, host: 'x.com', title: `p${i}`, secs: 10 }));
  const notes = { entries: [], images: [{ id: 'im1', name: 'a.png', mime: 'image/png', path: '/x/a.png', ts: '2026-09-07T03:00:00Z', forKey: 'web@2026-09-07T02:01' }] };
  const mods = buildModules({ projects: [], gitByProject: new Map(), sessionsByProject: new Map(), filesByProject: new Map(), nowIso: '2026-09-07T12:00:00Z', webVisits: visits, notes }, { localDate: '2026-09-07' });
  assert.deepEqual(notesModules(notes, '2026-09-07'), [], '只有给泡泡补的图、没有手记条目：没有手记模块');
  const web = mods.find((m) => m.key === 'web@2026-09-07T02:01');
  assert.ok(web, mods.map((m) => m.key).join());
  assert.equal(web.stats.images, 1);
  assert.deepEqual(web.items.filter((i) => i.kind === 'image').map((i) => [i.imageId, i.forKey]), [['im1', 'web@2026-09-07T02:01']]);
  assert.ok(web.sourceIds.includes('image:im1'));
  const dup = [{ key: 'a@1', startTs: '2026-09-07T02:00:00Z' }, { key: 'a@1', startTs: '2026-09-07T01:00:00Z' }, { key: 'b@1', startTs: '2026-09-07T03:00:00Z' }];
  dedupeKeys(dup);
  assert.deepEqual(dup.map((m) => m.key), ['a@1#2', 'a@1', 'b@1'], '早的那段保留原键');
  void attachHintImages;
});
