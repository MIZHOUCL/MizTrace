import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, setNotes, setDraft, aiUsageToday, logAiRun } from '../src/db.js';
import { createLibraryDocument, saveLibraryDocument, listLibraryDocuments, libraryHistory } from '../src/journal-library.js';
import { reportOptions, reportSources, selectedReportSources } from '../src/reports.js';
import { createReport, saveReport, readReport } from '../src/report-store.js';
import { prepareReportPrompt, validateReportFacts, validateReportReview, generateReport, renderReport, localReport } from '../src/ai/reports.js';
import { startServer } from '../src/server/index.js';
import { DEFAULTS, loadConfig } from '../src/config.js';
import { REPORT_TEMPLATES, reportTemplatesOf, normalizeReportTemplates, pickReportTemplate } from '../src/report-templates.js';
import { todayLocalDate } from '../src/time.js';

const options = { start: '2026-11-23', end: '2026-11-27', kind: 'week', template: 'work' };
const content = 'MizTrace：完成日记目录管理，新增 8 项测试均通过。\n报表项目：导入接口仍在等待测试环境。\n下周计划补充 macOS 签名验证。';
const source = { id: 'journal:2026-11-26', date: '2026-11-26', title: '项目进展', content, revision: 'test' };
const prepared = () => prepareReportPrompt({ options: reportOptions(options), sources: [source], warnings: [] });
const card = (patch = {}) => ({ project: 'MizTrace', topic: '目录管理', status: 'done', text: '完成日记目录管理，新增 8 项测试均通过。', refs: ['s1'], quotes: [{ ref: 's1', text: '完成日记目录管理，新增 8 项测试均通过。' }], ...patch });
const ai = { model: 'fixture-model', baseUrl: 'https://model.example/v1', apiKey: 'fixture-key', protocol: 'openai', maxTokens: 4000 };
function model(script) {
  const requests = [];
  return { requests, fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body); requests.push(body);
    const data = script(body, requests.length);
    return { ok: true, text: async () => JSON.stringify({ model: 'fixture-model', usage: { prompt_tokens: 100, completion_tokens: 50 }, choices: [{ finish_reason: 'stop', message: { content: typeof data === 'string' ? data : JSON.stringify(data) } }] }) };
  } };
}
function setup(t) {
  const db = openDb(':memory:'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miztrace-reports-'));
  const cfg = { journalLibrary: { roots: [fs.realpathSync(dir)] } };
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { db, dir, cfg };
}

test('报告日期验证真实日期、闰年、跨年与 62 天上限', () => {
  assert.equal(reportOptions({ ...options, start: '2024-02-01', end: '2024-02-29' }).days, 29);
  assert.equal(reportOptions({ ...options, start: '2026-12-28', end: '2027-01-03' }).days, 7);
  for (const patch of [{ start: '2026-02-30' }, { end: '2026-11-22' }, { end: '2027-02-01' }, { kind: 'year' }, { template: 'unknown' }]) assert.throws(() => reportOptions({ ...options, ...patch }));
});
test('素材范围、同文副本去重、同日不同草稿默认不选、手记与未标日期提示', (t) => {
  const { db, cfg, dir } = setup(t);
  const doc = createLibraryDocument(db, cfg, '2026-11-26').document;
  saveLibraryDocument(db, cfg, { ...doc, markdown: content });
  fs.writeFileSync(path.join(dir, '2026-11-26.md'), content);
  fs.writeFileSync(path.join(dir, 'README.md'), '# 未标注日期');
  fs.writeFileSync(path.join(dir, '2026-11-01.md'), '# 本期之外');
  setDraft(db, '2026-11-26', '不同的草稿', {});
  setNotes(db, '2026-11-27', { entries: [{ id: 'n1', text: '补充一条手记' }] });
  const data = reportSources(db, cfg, options);
  assert.equal(data.sources.length, 3);
  assert.equal(data.sources.find((s) => s.kind === 'draft').selected, false);
  assert.ok(data.sources.some((s) => s.kind === 'notes'));
  assert.match(data.warnings.join(), /未标注日期/); assert.match(data.warnings.join(), /副本/);
  assert.throws(() => selectedReportSources(db, cfg, { ...options, sourceIds: ['file:invalid'] }), { status: 409 });
  assert.throws(() => selectedReportSources(db, cfg, { ...options, sourceIds: [] }), { status: 400 });
});
test('超长素材明确拒绝，不静默截断，来源块全部保留', (t) => {
  const { db, cfg, dir } = setup(t);
  fs.writeFileSync(path.join(dir, '2026-11-26.md'), '工作进展'.repeat(16_000));
  const data = reportSources(db, cfg, options);
  assert.throws(() => selectedReportSources(db, cfg, { ...options, sourceIds: [data.sources[0].id] }), { status: 413 });
  const long = { ...source, content: '已完成一项改进。\n'.repeat(3000) };
  const p = prepareReportPrompt({ options, sources: [long], warnings: [] });
  assert.equal(p.chunks.map((s) => s.content).join(''), long.content);
  assert.ok(p.batches.length >= 2);
});
test('引句原文匹配、编号与数字校验，拒绝伪造成果和无来源内容', () => {
  const p = prepared();
  assert.equal(validateReportFacts({ facts: [card()] }, p.chunks).length, 1);
  for (const patch of [
    { refs: ['s9'] }, { quotes: [] }, { quotes: [{ ref: 's1', text: '原文从来没写的成果' }] },
    { text: '新增 18 项测试均通过。' }, { text: '效率提升 80%。' }, { status: 'verified' },
  ]) assert.throws(() => validateReportFacts({ facts: [card(patch)] }, p.chunks));
});
test('审核不能生成新事实、把计划列为成果或掩盖冲突', () => {
  const facts = [{ ...card(), id: 'f1' }, { ...card({ status: 'plan' }), id: 'f2' }];
  assert.throws(() => validateReportReview({ keep: ['f3'], highlights: [], conflicts: [] }, facts));
  assert.throws(() => validateReportReview({ keep: ['f1', 'f2'], highlights: ['f2'], conflicts: [] }, facts));
  assert.throws(() => validateReportReview({ keep: ['f1', 'f2'], highlights: ['f1'], conflicts: [['f1', 'f2']] }, facts));
  const review = validateReportReview({ keep: ['f1', 'f2'], highlights: [], conflicts: [['f1', 'f2']] }, facts);
  const rendered = renderReport(prepared(), facts, review).markdown;
  assert.match(rendered, /记录冲突/); assert.match(rendered, /1\/5/);
  assert.match(rendered, /没有明确的后续计划/);
});
test('两阶段生成成功：结构固定、项目分开、带引句、调用与用量统计准确', async () => {
  const deps = model((_body, n) => n === 1 ? { facts: [card(), card({ project: '报表项目', topic: '导入接口', status: 'blocked', text: '导入接口仍在等待测试环境。', quotes: [{ ref: 's1', text: '导入接口仍在等待测试环境。' }] })] } : { keep: ['f1', 'f2'], highlights: ['f1'], conflicts: [] });
  const phases = [], result = await generateReport({ ai }, prepared(), { ...deps, onProgress: (v) => phases.push(v) });
  assert.equal(result.metadata.calls, 2); assert.deepEqual(result.metadata.usage, { input: 200, output: 100 });
  assert.match(result.markdown, /### MizTrace/); assert.match(result.markdown, /### 报表项目/); assert.match(result.markdown, /问题与风险/);
  assert.match(result.markdown, /\[S1\]/); assert.equal(result.metadata.facts.length, 2); assert.ok(phases.some((s) => s.includes('审核')));
  assert.ok(!deps.requests[0].messages[1].content.includes('journal:2026-11-26'), '内部文件标识不发送给模型');
});

test('21份月报素材分成小批完整发送，输出预算采用用户设置', async () => {
  const sources = Array.from({ length: 21 }, (_, i) => ({ ...source, id: `journal:fixture-${i}`, date: `2026-11-${String(i + 1).padStart(2, '0')}`, content: `${content}\n${'素材正文。'.repeat(450)}` }));
  const p = prepareReportPrompt({ options: reportOptions({ ...options, start: '2026-11-01', end: '2026-11-30', kind: 'month' }), sources, warnings: [] });
  assert.equal(p.daysCovered, 21);
  assert.ok(p.batches.length > 4 && p.batches.length <= 24);
  for (const batch of p.batches) assert.ok(JSON.stringify(batch).length <= 8000);
  for (const s of sources) assert.equal(p.chunks.filter((c) => c.sourceId === s.id).map((c) => c.content).join(''), s.content);
  const deps = model((body) => {
    const input = JSON.parse(body.messages[1].content);
    return input.sources ? { facts: [card({ refs: [input.sources[0].ref], quotes: [{ ref: input.sources[0].ref, text: card().text }] })] }
      : { keep: input.map((f) => f.id), highlights: ['f1'], conflicts: [] };
  });
  const result = await generateReport({ ai: { ...ai, maxTokens: 1500 } }, p, deps);
  assert.equal(result.metadata.quality, 'checked');
  assert.equal(deps.requests.length, p.estimatedCalls);
  assert.ok(deps.requests.every((body) => body.max_tokens === 1500));
  const sent = deps.requests.slice(0, -1).flatMap((body) => JSON.parse(body.messages[1].content).sources);
  assert.deepEqual(sent.map((c) => c.content), p.chunks.map((c) => c.content));
});

test('月报一批实际超时后拆成两批恢复，引用稳定，失败调用也记账', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const p = prepareReportPrompt({ options: reportOptions(options), sources: [source, { ...source, id: 'other', content: `${content}\n${'补充'.repeat(1400)}` }], warnings: [] });
  assert.equal(p.batches.length, 1);
  const success = model((body) => {
    const input = JSON.parse(body.messages[1].content);
    return input.sources ? { facts: [card({ refs: [input.sources[0].ref], quotes: [{ ref: input.sources[0].ref, text: card().text }] })] }
      : { keep: ['f1'], highlights: ['f1'], conflicts: [] };
  });
  let requests = 0; const logs = [], phases = [];
  const pending = generateReport({ ai }, p, { fetchImpl: async (url, init) => {
    if (++requests === 1) return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
    return success.fetchImpl(url, init);
  }, onCall: (result, ok, error) => logs.push({ result, ok, error }), onProgress: (msg) => phases.push(msg) });
  while (!requests) await Promise.resolve();
  t.mock.timers.tick(180_001);
  const result = await pending;
  assert.equal(result.metadata.quality, 'checked');
  assert.equal(result.metadata.calls, 4);
  assert.deepEqual(result.metadata.usage, { input: 300, output: 150 });
  assert.deepEqual(result.metadata.facts[0].refs, ['s1', 's2']);
  assert.deepEqual(logs.map((l) => l.ok), [false, true, true, true]);
  assert.match(logs[0].error, /180.*超时|超时.*180/);
  assert.ok(phases.some((s) => s.includes('拆成更小')));
});

test('单块重分保留完整原文与原ref，不在表情代理对中间切开', async () => {
  const text = '甲'.repeat(2499) + '😀' + '乙'.repeat(2499);
  const p = prepareReportPrompt({ options, sources: [{ ...source, content: text }], warnings: [] });
  const deps = model((_body, n) => { if (n === 1) throw new Error('fixture disconnected'); return { facts: [] }; });
  const result = await generateReport({ ai }, p, deps);
  const halves = deps.requests.slice(1).flatMap((b) => JSON.parse(b.messages[1].content).sources);
  assert.equal(halves.length, 2); assert.equal(halves.map((s) => s.content).join(''), text);
  assert.ok(halves.every((s) => s.ref === 's1'));
  assert.equal(halves[1].content.startsWith('😀'), true);
  assert.equal(result.metadata.sources[0].content, text);
});

test('后续批次连续断线时停止调用，保存已有事实和全部原文，标出未处理批次', async () => {
  const p = prepareReportPrompt({ options, sources: [{ ...source, content: content + '前文'.repeat(2500) }, { ...source, id: 'other', content: content + '补充'.repeat(2700) }, { ...source, id: 'last', content: '最后一批'.repeat(1400) }], warnings: [] });
  assert.equal(p.batches.length, 3);
  const deps = model((_body, n) => { if (n === 1) return { facts: [card()] }; throw new Error('fixture disconnected'); });
  const result = await generateReport({ ai }, p, deps);
  assert.equal(result.metadata.quality, 'partial'); assert.equal(result.metadata.calls, 3);
  assert.equal(deps.requests.length, 3); assert.equal(result.metadata.facts[0].text, card().text);
  assert.equal(result.metadata.sources.map((s) => s.content).join(''), p.chunks.map((s) => s.content).join(''));
  assert.ok(result.metadata.warnings.some((w) => w.refs.includes('s3') && /停止/.test(w.message)));
  assert.ok(result.metadata.warnings.some((w) => w.stage === 'review'));
  assert.match(result.markdown, /待核对草稿/);
});

test('整篇审核服务失败保留已核对事实，服务持续不可用则返回原文整理版', async () => {
  const deps = model((_body, n) => { if (n === 1) return { facts: [card()] }; throw new Error('fixture disconnected'); });
  const result = await generateReport({ ai }, prepared(), deps);
  assert.equal(result.metadata.quality, 'partial'); assert.equal(result.metadata.calls, 2);
  assert.equal(result.metadata.warnings[0].stage, 'review'); assert.match(result.markdown, /目录管理/);
  const p = prepareReportPrompt({ options, sources: [{ ...source, content: content.repeat(20) }], warnings: [] });
  const down = model(() => { throw new Error('fixture unavailable'); });
  const fallback = await generateReport({ ai }, p, down);
  assert.equal(down.requests.length, 2); assert.equal(fallback.metadata.quality, 'fallback');
  assert.equal(fallback.metadata.calls, 2); assert.deepEqual(fallback.metadata.usage, { input: 0, output: 0 });
  for (const line of content.split('\n')) assert.ok(fallback.markdown.includes(line));
});

test('认证失败不拆分或吞掉；每次调用前的外发权限检查立即中止', async () => {
  let calls = 0;
  await assert.rejects(generateReport({ ai }, prepared(), { fetchImpl: async () => { calls++; return { ok: false, status: 401, text: async () => 'fixture unauthorized' }; } }), /HTTP 401/);
  assert.equal(calls, 1);
  const deps = model(() => ({ facts: [card()] }));
  let guards = 0;
  await assert.rejects(generateReport({ ai }, prepared(), { ...deps, beforeCall: () => { if (++guards === 2) assertOutboundBlocked(); } }), /fixture privacy/);
  assert.equal(deps.requests.length, 1);
  function assertOutboundBlocked() { throw new Error('fixture privacy disabled'); }
});

test('中途达到每日上限不再调用，保存已有事实为未完成审核的草稿', async () => {
  let before = 0;
  const deps = model(() => ({ facts: [card()] }));
  const result = await generateReport({ ai }, prepared(), { ...deps, beforeCall: () => {
    if (++before > 1) throw Object.assign(new Error('fixture daily limit'), { code: 'AI_DAILY_LIMIT' });
  } });
  assert.equal(result.metadata.calls, 1); assert.equal(deps.requests.length, 1);
  assert.equal(result.metadata.quality, 'partial'); assert.match(result.markdown, /目录管理/);
  assert.match(result.metadata.warnings[0].message, /daily limit/);
});

test('月报空思考输出也会提高预算重试，随后成功不误标为不完整', async () => {
  let count = 0;
  const deps = model((body, n) => n === 1 ? '' : n === 2 ? { facts: [card()] } : { keep: ['f1'], highlights: ['f1'], conflicts: [] });
  const result = await generateReport({ ai: { ...ai, maxTokens: 1000 } }, prepared(), { fetchImpl: async (url, init) => {
    const res = await deps.fetchImpl(url, init);
    if (++count !== 1) return res;
    return { ok: true, text: async () => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '', reasoning_content: 'fixture thinking' } }] }) };
  } });
  assert.equal(result.metadata.quality, 'checked');
  assert.equal(deps.requests[0].max_tokens, 1000); assert.equal(deps.requests[1].max_tokens, 16_000);
});
test('没有完成反馈不等于推进中：方案作为产出呈现，明确等待和阻塞继续保留', () => {
  const check = (quote, status = 'progress') => validateReportFacts({ facts: [card({ status, text: '形成接口重试修复方案。', quotes: [{ ref: 's1', text: quote }] })] }, [{ ref: 's1', date: source.date, content: quote }])[0];
  for (const quote of ['形成接口重试修复方案，未记录修正后的验证结果。', '接口重试已有修复方法，用户没有反馈是否完成。', '推进中：定位失败响应导致重复重传，修改已提交，未记录验证结果。']) {
    assert.equal(check(quote).status, 'activity', quote);
    assert.equal(check(quote, 'blocked').status, 'activity', quote);
  }
  assert.equal(check('修复方案已经提交，仍在等待测试环境。').status, 'progress');
  assert.equal(check('未记录验证结果，但仍在等待设备重新连接。', 'blocked').status, 'blocked');
  const fact = { ...check('形成接口重试修复方案。'), id: 'f1' };
  const report = renderReport(prepared(), [fact], { keep: ['f1'], highlights: ['f1'], conflicts: [] }).markdown;
  assert.match(report.split('## 项目进展')[0], /形成接口重试修复方案/);
  assert.doesNotMatch(report, /推进中|已完成：|待验证/);
});

test('报告模板独立于日记模板，内置可覆盖和恢复，非法或超长输入不静默保存', () => {
  const builtin = REPORT_TEMPLATES[0];
  assert.deepEqual(normalizeReportTemplates(REPORT_TEMPLATES), []);
  const custom = { ...builtin, id: 'my-report', name: '我的周报', prompt: '突出本周形成的解决方法，简洁直接。', sections: ['本期产出', '协作事项'] };
  const stored = normalizeReportTemplates([{ ...builtin, prompt: '先写结论。' }, custom]);
  const cfg = { ai: { templates: [{ id: 'diary', text: '日记专用要求' }] }, reports: { templates: stored } };
  assert.equal(reportTemplatesOf(cfg).length, REPORT_TEMPLATES.length + 1);
  assert.equal(pickReportTemplate(cfg, 'work').modified, true);
  assert.equal(reportOptions({ ...options, template: custom.id }, cfg).template, custom.id);
  assert.equal(reportTemplatesOf({ reports: { templates: [] } })[0].prompt, builtin.prompt);
  assert.equal(reportTemplatesOf(cfg).some((t) => t.id === 'diary'), false);
  for (const patch of [{ prompt: '' }, { prompt: '长'.repeat(6001) }, { sections: [] }, { sections: ['重复', '重复'] }, { id: '../bad' }]) assert.throws(() => normalizeReportTemplates([{ ...custom, ...patch }]));
});

test('自定义提示词用于两阶段并按自定义章节排版，历史保留本次提示词快照', async () => {
  const template = { id: 'my-report', name: '给团队的汇报', prompt: '突出解决方法，按项目写，每项一句话。', description: '', sections: ['本期产出', '需要协作'] };
  const p = prepareReportPrompt({ options: { ...reportOptions(options), template: template.id }, template, sources: [source], warnings: [] });
  const deps = model((_body, n) => n === 1 ? { facts: [card(), card({ project: '报表项目', topic: '导入', status: 'blocked', text: '导入接口仍在等待测试环境。', quotes: [{ ref: 's1', text: '导入接口仍在等待测试环境。' }] })] }
    : { keep: ['f1', 'f2'], highlights: ['f1'], conflicts: [], sections: [{ title: '本期产出', facts: ['f1'] }, { title: '需要协作', facts: ['f2'] }] });
  const result = await generateReport({ ai }, p, deps);
  assert.match(result.markdown, /## 本期产出/); assert.match(result.markdown, /## 需要协作/);
  assert.doesNotMatch(result.markdown, /## 项目进展与成果/);
  assert.equal(deps.requests[0].messages[0].content, p.instructions.extract);
  assert.equal(deps.requests[1].messages[0].content, p.instructions.review);
  for (const request of deps.requests) assert.ok(request.messages[0].content.includes(template.prompt));
  template.prompt = '后来修改的提示词';
  assert.equal(result.metadata.template.prompt, '突出解决方法，按项目写，每项一句话。');
  assert.equal(result.metadata.quality, 'checked');
});

const fiveWSource = { ...source, content: 'MizTrace：为解决月报超时，研发组由陈工负责、林主管负责审核，已拆分素材批次，新增 8 项测试通过。\n下周计划由陈工补充故障回归，计划于2026年12月4日完成，目标覆盖 3 种故障。' };
const fiveWFacts = () => [
  card({ topic: '月报生成修复', text: '拆分素材批次，新增 8 项测试通过。', quotes: [{ ref: 's1', text: fiveWSource.content.split('\n')[0] }],
    fiveW2H: { why: '为解决月报超时', what: '已拆分素材批次', how: '拆分素材批次', howMuch: '新增 8 项测试通过', where: '研发组', who: '陈工', leader: '林主管' } }),
  card({ topic: '故障回归', status: 'plan', text: '下周计划补充故障回归，目标覆盖 3 种故障。', quotes: [{ ref: 's1', text: fiveWSource.content.split('\n')[1] }],
    fiveW2H: { what: '下周计划由陈工补充故障回归', howMuch: '目标覆盖 3 种故障', when: '计划于2026年12月4日完成', who: '陈工' } }),
];
function fiveWPrepared(kind = 'week', lang = 'zh') {
  return prepareReportPrompt({ options: reportOptions({ ...options, kind, template: '5w2h', lang }), sources: [fiveWSource], warnings: [] });
}

test('5W2H模板周报月报通用，提示词和事项表布局可编辑、复制、恢复', () => {
  const base = pickReportTemplate({}, '5w2h');
  assert.equal(base.layout, '5w2h'); assert.equal(base.builtin, true);
  for (const kind of ['week', 'month']) {
    const p = fiveWPrepared(kind);
    assert.ok(p.instructions.extract.includes(base.prompt)); assert.ok(p.instructions.review.includes(base.prompt));
    assert.match(p.instructions.extract, /fiveW2H.*字段含义/s);
    assert.match(p.instructions.extract, /计划期限，不用素材日期补齐/);
  }
  const copy = { ...base, id: 'my-5w2h', name: '我的计划表', prompt: base.prompt + '重点呈现交付。' };
  const stored = normalizeReportTemplates([copy, { ...base, prompt: base.prompt + '每项简洁。' }]);
  assert.equal(stored.length, 2); assert.ok(stored.every((t) => t.layout === '5w2h'));
  assert.equal(pickReportTemplate({ reports: { templates: stored } }, copy.id).layout, '5w2h');
  assert.equal(pickReportTemplate({ reports: { templates: stored } }, base.id).modified, true);
  assert.deepEqual(normalizeReportTemplates(REPORT_TEMPLATES), []);
  assert.throws(() => normalizeReportTemplates([{ ...copy, layout: 'unknown' }]), /展示方式/);
  assert.throws(() => normalizeReportTemplates([{ ...copy, sections: ['只有总结'] }]), /至少/);
});

test('5W2H字段逐字核对本条引句，不接受虚构人名、日期、效果或其他事项的资料', () => {
  const p = fiveWPrepared(), good = fiveWFacts()[0];
  assert.deepEqual(validateReportFacts({ facts: [good] }, p.chunks, p.template)[0].fiveW2H, good.fiveW2H);
  for (const patch of [{ who: '不存在的负责人' }, { when: source.date }, { howMuch: '节省 100 万元' }, { who: '补充故障回归' }, { mystery: '陈工' }]) {
    assert.throws(() => validateReportFacts({ facts: [{ ...good, fiveW2H: { ...good.fiveW2H, ...patch } }] }, p.chunks, p.template), /5W2H/);
  }
  assert.throws(() => validateReportFacts({ facts: [card()] }, prepared().chunks, p.template), /fiveW2H/);
  assert.throws(() => validateReportFacts({ facts: [{ ...good, fiveW2H: { who: '陈工' } }] }, p.chunks, p.template), /what/);
});

test('5W2H报告按总结与计划分别展示，缺少完成反馈、负责人或期限不编造', async () => {
  for (const kind of ['week', 'month']) {
    const p = fiveWPrepared(kind);
    const deps = model((_body, n) => n === 1 ? { facts: fiveWFacts() } : { keep: ['f1', 'f2'], highlights: ['f1'], conflicts: [],
      sections: [{ title: p.template.sections[0], facts: ['f1'] }, { title: p.template.sections[1], facts: ['f2'] }] });
    const result = await generateReport({ ai }, p, deps);
    assert.equal(result.metadata.quality, 'checked'); assert.equal(result.metadata.calls, 2);
    assert.match(result.markdown, kind === 'week' ? /周报/ : /月报/);
    const summary = result.markdown.split('## 本期工作总结')[1].split('## 下一期工作计划')[0];
    const plan = result.markdown.split('## 下一期工作计划')[1];
    assert.match(summary, /目的 \/ 问题点（Why）/); assert.match(summary, /责任领导 \| 林主管/);
    assert.match(summary, /计划完成时间（When） \| 未记录/); assert.match(summary, /完成情况 \| 未记录/);
    assert.doesNotMatch(summary, /目标覆盖 3|2026年12月4日|推进中/);
    assert.match(plan, /目标覆盖 3 种故障/); assert.match(plan, /计划于2026年12月4日完成/);
    assert.match(plan, /执行单位（Where） \| 未记录/);
    assert.equal(result.metadata.template.layout, '5w2h');
    assert.deepEqual(result.metadata.facts[1].fiveW2H, fiveWFacts()[1].fiveW2H);
  }
});

test('5W2H不把未来计划放进本期总结；无计划与整篇审核失败仍显示正确章节', async () => {
  const p = fiveWPrepared(), facts = validateReportFacts({ facts: fiveWFacts() }, p.chunks, p.template).map((f, i) => ({ ...f, id: `f${i + 1}` }));
  const review = { keep: ['f1', 'f2'], highlights: ['f1'], conflicts: [] };
  assert.throws(() => validateReportReview({ ...review, sections: [{ title: p.template.sections[0], facts: ['f1', 'f2'] }] }, facts, p.template), /未来计划/);
  assert.throws(() => validateReportReview({ ...review, sections: [{ title: p.template.sections[1], facts: ['f1', 'f2'] }] }, facts, p.template), /未来计划/);
  const fallback = renderReport(p, facts, review).markdown;
  assert.ok(fallback.indexOf('#### 月报生成修复') < fallback.indexOf('## 下一期工作计划'));
  assert.ok(fallback.indexOf('#### 故障回归') > fallback.indexOf('## 下一期工作计划'));
  const deps = model((_body, n) => n === 1 ? { facts: [fiveWFacts()[0]] } : { keep: ['f1'], highlights: ['f1'], conflicts: [], sections: [{ title: p.template.sections[0], facts: ['f1'] }] });
  const result = await generateReport({ ai }, p, deps);
  assert.match(result.markdown, /## 下一期工作计划\n\n未记录下一期工作计划/);
});

test('5W2H相同概述但字段不同不能提前去重，历史快照保留字段和原文', async () => {
  const p = fiveWPrepared();
  const a = fiveWFacts()[0], b = { ...a, fiveW2H: { ...a.fiveW2H, who: '林主管' } };
  const deps = model((_body, n) => n === 1 ? { facts: [a, b] } : { keep: ['f1', 'f2'], highlights: [], conflicts: [['f1', 'f2']], sections: [] });
  const result = await generateReport({ ai }, p, deps);
  assert.equal(result.metadata.facts.length, 2);
  assert.match(result.markdown, /记录冲突/); assert.match(result.markdown, /责任人（Who） \| 陈工/); assert.match(result.markdown, /责任人（Who） \| 林主管/);
  const db = openDb(':memory:');
  try {
    const saved = createReport(db, { ...p.options, ...result });
    const history = readReport(db, saved.id);
    assert.equal(history.metadata.template.layout, '5w2h'); assert.equal(history.metadata.facts[0].fiveW2H.who, '陈工');
    assert.equal(history.metadata.sources[0].content, fiveWSource.content);
  } finally { db.close(); }
});

test('5W2H英文标题、字段和空值可读，表格中的竖线不会破坏Markdown列', () => {
  const p = fiveWPrepared('month', 'en');
  const f = { ...fiveWFacts()[0], id: 'f1', fiveW2H: { ...fiveWFacts()[0].fiveW2H, how: '方案A | 方案B' } };
  const markdown = renderReport(p, [f], { keep: ['f1'], highlights: [], conflicts: [], sections: [{ title: p.template.englishSections[0], facts: ['f1'] }] }).markdown;
  assert.match(markdown, /Monthly report/); assert.match(markdown, /Work plan for the next period/); assert.match(markdown, /Owner \(Who\)/);
  assert.match(markdown, /Not recorded/); assert.match(markdown, /方案A ｜ 方案B/);
});

test('模板章节不能引入新事实、遗漏已选事实或重复展示，定制模板必须返回章节', () => {
  const facts = [{ ...card(), id: 'f1' }, { ...card({ status: 'activity' }), id: 'f2' }];
  const template = { sections: ['本期产出'] }, review = { keep: ['f1', 'f2'], highlights: [], conflicts: [] };
  for (const sections of [[{ title: '本期产出', facts: ['f9'] }], [{ title: '本期产出', facts: ['f1'] }], [{ title: '其他标题', facts: ['f1', 'f2'] }], [{ title: '本期产出', facts: ['f1', 'f1'] }]]) assert.throws(() => validateReportReview({ ...review, sections }, facts, template));
  assert.throws(() => validateReportReview(review, facts, template), /sections/);
  assert.deepEqual(validateReportReview({ ...review, sections: [{ title: '本期产出', facts: ['f1', 'f2'] }] }, facts, template).sections[0].facts, ['f1', 'f2']);
});

test('本地汇编直接保留素材，没有空白待填模板；模板中的密钥同样阻止 AI 外发', async () => {
  const result = localReport(prepared());
  for (const line of content.split('\n')) assert.ok(result.markdown.includes(line));
  assert.doesNotMatch(result.markdown, /待填写/);
  assert.match(result.markdown, /未执行模板提示词/);
  const p = prepareReportPrompt({ options, sources: [source], template: { ...REPORT_TEMPLATES[0], prompt: 'sk-proj-' + 'a'.repeat(30) } });
  const deps = model(() => { throw new Error('不应调用'); });
  await assert.rejects(generateReport({ ai }, p, deps), /密钥/);
  assert.equal(deps.requests.length, 0);
});
test('坏引用仅重试一次，随后返回明确标注的原文整理版，每次调用均记账', async () => {
  const deps = model(() => ({ facts: [card({ refs: ['not-real'] })] })), logs = [];
  const result = await generateReport({ ai }, prepared(), { ...deps, onCall: (_r, ok) => logs.push(ok) });
  assert.equal(result.metadata.source, 'local-fallback'); assert.equal(result.metadata.quality, 'fallback');
  assert.match(result.markdown, /资料整理版/); assert.match(result.markdown, /待整理的原始素材/);
  assert.match(result.markdown, /未能获得可采用的 AI 内容/);
  assert.doesNotMatch(result.markdown, /尚未进行 AI 提炼/);
  assert.ok(result.metadata.warnings.length); assert.equal(result.metadata.facts, undefined);
  assert.equal(deps.requests.length, 2); assert.deepEqual(logs, [false, false]);
});
test('纠正后成功且所有调用的 token 均统计；重复事实去重', async () => {
  const deps = model((_body, n) => n === 1 ? '不是 JSON' : n === 2 ? { facts: [card(), card()] } : { keep: ['f1'], highlights: ['f1'], conflicts: [] });
  const result = await generateReport({ ai }, prepared(), deps);
  assert.equal(result.metadata.calls, 3); assert.equal(result.metadata.usage.input, 300); assert.equal(result.metadata.facts.length, 1);
});
test('纠错成功后不叠加早先已被替换的事实表述', async () => {
  const deps = model((_body, n) => n === 1 ? { facts: [card({ text: '完成日记目录管理。' }), card({ topic: '收益', text: '效率提升 99%。' })] }
    : n === 2 ? { facts: [card()] } : { keep: ['f1'], highlights: ['f1'], conflicts: [] });
  const result = await generateReport({ ai }, prepared(), deps);
  const reviewInput = JSON.parse(deps.requests[2].messages[1].content);
  assert.equal(reviewInput.length, 1); assert.equal(reviewInput[0].text, card().text);
  assert.equal(result.metadata.facts.length, 1); assert.equal(result.metadata.quality, 'checked');
});
test('空白事实保留原文供整理，受管设备与密钥熔断均零外发', async () => {
  const deps = model(() => ({ facts: [] }));
  const fallback = await generateReport({ ai }, prepared(), deps);
  assert.equal(fallback.metadata.quality, 'fallback'); assert.equal(deps.requests.length, 1);
  const zero = model(() => { throw new Error('不应调用'); });
  await assert.rejects(generateReport({ ai, managedDevice: true }, prepared(), zero), /外发/);
  const p = prepareReportPrompt({ options, sources: [{ ...source, content: 'sk-proj-' + 'a'.repeat(30) }], warnings: [] });
  await assert.rejects(generateReport({ ai }, p, zero), /密钥/);
  assert.equal(zero.requests.length, 0); assert.match(localReport(prepared()).markdown, /资料整理版/);
});

test('等价数字、中文数量、日期和引文标记不误判；不能借此改变数值或百分比', () => {
  const check = (quote, text, extra = {}) => validateReportFacts({ facts: [card({ text, quotes: [{ ref: 's1', text: quote }], ...extra })] }, [{ ref: 's1', date: '2026-11-27', content: quote }]);
  for (const [quote, text] of [
    ['完成 1,000 条数据校验。', '完成 1000 条数据校验。'],
    ['覆盖率达到 80％。', '覆盖率达到 80%。'],
    ['新增八项测试通过。', '新增8项测试通过。'],
    ['修复二十一个问题。', '修复21个问题。'],
    ['耗时 1.0 秒。', '耗时 1 秒。'],
    ['修复问题并完成验证。', '2026年11月27日修复问题并完成验证。[S1]'],
    ['完成数据校验。', '1. 完成数据校验。'],
  ]) assert.equal(check(quote, text).length, 1, text);
  for (const [quote, text] of [
    ['新增八项测试通过。', '新增18项测试通过。'],
    ['覆盖率达到 80%。', '覆盖率达到 90%。'],
    ['处理了 80 条记录。', '效率提升 80%。'],
    ['数值变化为 -8。', '数值变化为 8。'],
    ['约一百二个问题。', '约102个问题。'],
  ]) assert.throws(() => check(quote, text), /数字/);
  assert.throws(() => check('完成8项测试。', '完成8项测试。', { topic: '通过99项测试' }), /事项中的数字 99/);
});

test('单条数字错误不丢掉有效事实，重试得到具体反馈，未采用内容明确标记', async () => {
  const deps = model((_body, n) => n < 3 ? { facts: [card(), card({ topic: '收益', text: '效率提升 99%。' })] } : { keep: ['f1'], highlights: ['f1'], conflicts: [] });
  const result = await generateReport({ ai }, prepared(), deps);
  assert.equal(result.metadata.quality, 'partial'); assert.equal(result.metadata.facts.length, 1);
  assert.match(result.markdown, /待核对草稿/); assert.match(result.markdown, /目录管理/);
  assert.doesNotMatch(result.markdown, /99%/); assert.match(result.metadata.warnings[0].message, /第 2 条事实.*99%/);
  assert.match(deps.requests[1].messages[0].content, /99%/);
  assert.ok(JSON.parse(deps.requests[1].messages[1].content).previousOutput);
  assert.equal(result.metadata.calls, 3);
});

test('整篇审核格式失败时保留已核对事实，并标记为待核对而不伪装审核通过', async () => {
  const deps = model((_body, n) => n === 1 ? { facts: [card()] } : { keep: ['unknown'], highlights: [], conflicts: [] });
  const result = await generateReport({ ai }, prepared(), deps);
  assert.equal(result.metadata.quality, 'partial'); assert.equal(result.metadata.warnings[0].stage, 'review');
  assert.match(result.markdown, /目录管理/); assert.deepEqual(result.metadata.review.highlights, []);
});

test('AI 用量包含校验失败的付费调用，避免重试绕过每日上限', () => {
  const db = openDb(':memory:');
  try {
    logAiRun(db, { localDate: '2026-11-27', ok: false, inputTokens: 100, outputTokens: 50, error: '数字校验失败' });
    logAiRun(db, { localDate: '2026-11-27', ok: true, inputTokens: 150, outputTokens: 60 });
    assert.deepEqual(aiUsageToday(db, '2026-11-27'), { calls: 2, input: 250, output: 110 });
  } finally { db.close(); }
});
test('报告独立保存、日记库编辑有冲突保护与历史，不作为下一轮素材', (t) => {
  const { db, cfg } = setup(t);
  const generated = localReport(prepared());
  const a = createReport(db, { ...options, ...generated }), b = createReport(db, { ...options, ...generated });
  assert.notEqual(a.id, b.id); assert.equal(listLibraryDocuments(db, cfg).documents.length, 2);
  const updated = saveLibraryDocument(db, cfg, { ...a, markdown: '# 编辑后的报告\n\n核对内容。' });
  assert.equal(updated.title, '编辑后的报告'); assert.equal(updated.metadata.edited, true);
  assert.throws(() => saveReport(db, { ...a, markdown: '旧版覆盖' }), { status: 409 });
  assert.equal(libraryHistory(db, cfg, a.id).revisions.length, 1);
  assert.equal(readReport(db, b.id).markdown, generated.markdown);
  assert.equal(reportSources(db, cfg, options).sources.length, 0);
});
test('API 预览绑定素材版本、后台生成保存、认证与每日调用上限', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miztrace-report-api-'));
  const cfg = { ...structuredClone(DEFAULTS), ai: { ...ai, dailyLimit: 2 }, journalLibrary: { roots: [] } };
  const deps = model((_body, n) => n === 1 ? { facts: [card()] } : { keep: ['f1'], highlights: ['f1'], conflicts: [] });
  const server = await startServer({ cfg, port: 0, dbFile: path.join(dir, 'data.db'), reportDeps: deps });
  t.after(async () => { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const call = (method, name, body) => server.api[`${method} /api/${name}`](new URLSearchParams(), body);
  const doc = (await call('POST', 'journals', { date: '2026-11-26' })).document;
  const updated = await call('PUT', 'journals/document', { ...doc, markdown: content });
  const input = { ...options, sourceIds: [doc.id] };
  const preview = await call('POST', 'reports/preview', input);
  const newer = await call('PUT', 'journals/document', { ...updated, markdown: content + '\n补充说明。' });
  await assert.rejects(call('POST', 'reports/generate', { token: preview.token, mode: 'ai' }), { code: 'SOURCES_CHANGED' });
  const confirmed = await call('POST', 'reports/preview', input);
  const job = await call('POST', 'reports/generate', { token: confirmed.token, mode: 'ai' });
  let state;
  for (let i = 0; i < 100; i++) {
    state = await server.api['GET /api/reports/job'](new URLSearchParams({ id: job.id }));
    if (state.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(state.status, 'done', state.error); assert.match(state.document.markdown, /目录管理/);
  const db = openDb(path.join(dir, 'data.db'));
  assert.equal(aiUsageToday(db, todayLocalDate(cfg.cutoffHour)).calls, 2); db.close();
  const again = await call('POST', 'reports/preview', input);
  await assert.rejects(call('POST', 'reports/generate', { token: again.token, mode: 'ai' }), /上限/);
  assert.equal((await fetch(`http://127.0.0.1:${server.port}/api/reports`)).status, 401);
  assert.equal((await call('GET', 'reports')).reports.length, 1);
  assert.ok(newer.revision);
});

test('报告模板 API 持久化、冲突保护、预览失效和恢复内置，不更改日记模板', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miztrace-report-template-api-'));
  const oldDataDir = process.env.MIZTRACE_DATA_DIR; process.env.MIZTRACE_DATA_DIR = dir;
  const cfg = structuredClone(DEFAULTS);
  cfg.ai.templates = [{ id: 'my-diary', name: '日记', text: '日记提示词' }];
  const server = await startServer({ cfg, port: 0, dbFile: path.join(dir, 'data.db') });
  t.after(async () => { await server.close(); if (oldDataDir === undefined) delete process.env.MIZTRACE_DATA_DIR; else process.env.MIZTRACE_DATA_DIR = oldDataDir; fs.rmSync(dir, { recursive: true, force: true }); });
  const call = (method, name, body) => server.api[`${method} /api/${name}`](new URLSearchParams(), body);
  const initial = await call('GET', 'reports');
  const custom = { ...REPORT_TEMPLATES[0], id: 'custom', name: '自定义汇报', prompt: '仅保留重要产出，按部门汇报。', sections: ['重要产出', '协作事项'] };
  const changed = await call('PUT', 'reports/templates', { templates: [...initial.templates, custom], template: custom.id, revision: initial.templateRevision });
  assert.equal(loadConfig().reports.templates[0].prompt, custom.prompt);
  assert.equal(loadConfig().ai.templates[0].id, 'my-diary');
  await assert.rejects(call('PUT', 'reports/templates', { templates: [], template: 'work', revision: initial.templateRevision }), { code: 'TEMPLATES_CHANGED' });
  const doc = (await call('POST', 'journals', { date: source.date })).document;
  await call('PUT', 'journals/document', { ...doc, markdown: content });
  const preview = await call('POST', 'reports/preview', { ...options, template: custom.id, sourceIds: [doc.id] });
  assert.equal(preview.template.prompt, custom.prompt); assert.ok(preview.instructions.extract.includes(custom.prompt));
  await call('PUT', 'reports/templates', { templates: changed.templates.map((t) => t.id === custom.id ? { ...t, prompt: '新的汇报要求' } : t), template: custom.id, revision: changed.templateRevision });
  await assert.rejects(call('POST', 'reports/generate', { token: preview.token, mode: 'local' }), { code: 'TEMPLATES_CHANGED' });
  const latest = await call('GET', 'reports');
  const restored = await call('PUT', 'reports/templates', { templates: [], template: 'work', revision: latest.templateRevision });
  assert.equal(restored.templates.length, REPORT_TEMPLATES.length);
  assert.equal(loadConfig().reports.templates.length, 0);
  assert.equal((await fetch(`http://127.0.0.1:${server.port}/api/reports/templates`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
});
