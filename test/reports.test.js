import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, setNotes, setDraft, aiUsageToday } from '../src/db.js';
import { createLibraryDocument, saveLibraryDocument, listLibraryDocuments, libraryHistory } from '../src/journal-library.js';
import { reportOptions, reportSources, selectedReportSources } from '../src/reports.js';
import { createReport, saveReport, readReport } from '../src/report-store.js';
import { prepareReportPrompt, validateReportFacts, validateReportReview, generateReport, renderReport, localReport } from '../src/ai/reports.js';
import { startServer } from '../src/server/index.js';
import { DEFAULTS } from '../src/config.js';
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
test('坏引用仅重试一次，失败不返回看似成功的报告，每次调用均记账', async () => {
  const deps = model(() => ({ facts: [card({ refs: ['not-real'] })] })), logs = [];
  await assert.rejects(generateReport({ ai }, prepared(), { ...deps, onCall: (_r, ok) => logs.push(ok) }), /未通过质量校验/);
  assert.equal(deps.requests.length, 2); assert.deepEqual(logs, [false, false]);
});
test('纠正后成功且所有调用的 token 均统计；重复事实去重', async () => {
  const deps = model((_body, n) => n === 1 ? '不是 JSON' : n === 2 ? { facts: [card(), card()] } : { keep: ['f1'], highlights: ['f1'], conflicts: [] });
  const result = await generateReport({ ai }, prepared(), deps);
  assert.equal(result.metadata.calls, 3); assert.equal(result.metadata.usage.input, 300); assert.equal(result.metadata.facts.length, 1);
});
test('空白事实拒绝生成，受管设备与密钥熔断均零外发，本地模板可用', async () => {
  const deps = model(() => ({ facts: [] }));
  await assert.rejects(generateReport({ ai }, prepared(), deps), /没有足够/);
  const zero = model(() => { throw new Error('不应调用'); });
  await assert.rejects(generateReport({ ai, managedDevice: true }, prepared(), zero), /外发/);
  const p = prepareReportPrompt({ options, sources: [{ ...source, content: 'sk-proj-' + 'a'.repeat(30) }], warnings: [] });
  await assert.rejects(generateReport({ ai }, p, zero), /密钥/);
  assert.equal(zero.requests.length, 0); assert.match(localReport(prepared()).markdown, /资料整理版/);
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
