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
  assert.equal(reportTemplatesOf(cfg).length, 4);
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
