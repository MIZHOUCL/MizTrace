/** 隔离数据 + 可控模型回复的真实浏览器回归。不调用用户的模型，不读取个人日记。 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { startServer } from '../src/server/index.js';
import { DEFAULTS, defaultSessionDirs } from '../src/config.js';
const { chromium } = await import(pathToFileURL(process.argv[2]).href);
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'miztrace-reports-ui-'));
const cfg = { ...structuredClone(DEFAULTS), setupDone: true, rootsConfigured: true, roots: [data], out: null,
  journalLibrary: { roots: [] }, fileScan: { enabled: false },
  sessionDirs: Object.fromEntries(Object.keys(defaultSessionDirs()).map((k) => [k, [path.join(data, 'missing')]])),
  ai: { ...DEFAULTS.ai, baseUrl: 'https://fixture.example/v1', model: 'fixture-model', apiKey: 'fixture-key', dailyLimit: 20 } };
const raw = 'MizTrace：完成日记目录管理，新增 8 项测试均通过。\n数据平台：导入接口仍在等待测试环境。\n下周计划补充 macOS 签名验证。';
let calls = 0, scenario = 'normal';
const reportDeps = { fetchImpl: async (_url, init) => {
  calls++;
  const rawInput = JSON.parse(JSON.parse(init.body).messages[1].content);
  const input = rawInput.input ?? rawInput;
  await new Promise((r) => setTimeout(r, 350));
  if (scenario === 'unavailable') return { ok: false, status: 503, text: async () => 'Fixture service unavailable' };
  const facts = [
    { project: 'MizTrace', topic: '独立日记目录', status: 'done', text: '完成日记目录管理，新增 8 项测试均通过。', quote: '完成日记目录管理，新增 8 项测试均通过。' },
    { project: '数据平台', topic: '导入联调', status: 'blocked', text: '导入接口仍在等待测试环境。', quote: '导入接口仍在等待测试环境。' },
    { project: 'MizTrace', topic: 'macOS 签名', status: 'plan', text: '下周计划补充 macOS 签名验证。', quote: '下周计划补充 macOS 签名验证。' },
  ].map(({ quote, ...f }) => ({ ...f, refs: [input.sources?.[0].ref || 's1'], quotes: [{ ref: input.sources?.[0].ref || 's1', text: quote }] }));
  if (input.sources && scenario === 'partial') facts.push({ ...facts[0], topic: '未经证实的收益', text: '效率提升 99%。' });
  if (input.sources && scenario === 'fallback') { facts.splice(0, facts.length, { ...facts[0], refs: ['unknown'] }); }
  const output = input.sources ? { facts } : { keep: ['f1', 'f2', 'f3'], highlights: ['f1'], conflicts: [] };
  return { ok: true, text: async () => JSON.stringify({ model: 'fixture-model', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }], usage: { prompt_tokens: 500, completion_tokens: 200 } }) };
} };
const server = await startServer({ cfg, port: 0, dbFile: path.join(data, 'data.db'), reportDeps });
const call = (method, route, body) => server.api[`${method} /api/${route}`](new URLSearchParams(), body);
const entry = (await call('POST', 'journals', { date: '2026-11-26' })).document;
await call('PUT', 'journals/document', { ...entry, markdown: raw });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => localStorage.setItem('mt_page', 'reports'));
  const page = await context.newPage(), errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(server.url);
  await page.getByRole('heading', { name: '把每天的进展，写成一份好报告' }).waitFor();
  // 固定日期，让回归不依赖执行日期。
  await page.getByLabel('开始日期', { exact: true }).fill('2026-11-23');
  await page.getByLabel('结束日期', { exact: true }).fill('2026-11-27');
  await page.getByRole('button', { name: '加载 / 刷新素材', exact: true }).click();
  await page.locator('.report-source-list input').waitFor();
  assert.equal(await page.locator('.report-source-list input:checked').count(), 1);
  await page.screenshot({ path: path.join(data, 'report-start.png'), fullPage: true });
  await page.getByRole('button', { name: '预览素材并生成报告 →', exact: true }).click();
  await page.getByRole('heading', { name: '确认本次报告素材', exact: true }).waitFor();
  assert.equal(calls, 0, '素材预览不调用模型');
  await page.locator('.report-preview-modal details summary').first().click();
  assert.ok((await page.locator('.report-preview-modal pre').first().innerText()).includes(raw));
  await page.getByRole('button', { name: '确认发送并生成', exact: true }).click();
  await page.locator('.report-progress').waitFor();
  assert.equal(await page.evaluate(() => window.dispatchEvent(new Event('miztrace-before-update', { cancelable: true }))), false);
  await page.getByRole('button', { name: '编辑报告', exact: true }).waitFor();
  assert.equal(calls, 2);
  assert.ok((await page.locator('.report-document').innerText()).includes('数据平台'));
  await page.locator('.report-audit summary').click();
  assert.equal(await page.locator('.report-audit blockquote').count(), 3);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(data, 'report-generated.png'), fullPage: true });
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 .md', exact: true }).click();
  assert.match((await download).suggestedFilename(), /周报\.md$/);
  await page.getByRole('button', { name: '编辑报告', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Markdown 正文', exact: true });
  await editor.waitFor();
  const original = await editor.inputValue();
  await editor.fill(original + '\n手动补充：已核对实际交付状态。\n');
  await page.getByRole('button', { name: /保存.*Ctrl S/ }).click();
  await page.getByText('✓ 已保存', { exact: true }).waitFor();
  await page.getByRole('button', { name: '历史版本', exact: true }).click();
  await page.locator('.version-list button').first().waitFor();
  assert.equal(await page.locator('.version-list button').count(), 1);
  await page.getByRole('button', { name: '周报 / 月报', exact: true }).click();
  await page.locator('.report-document').getByText('手动补充：已核对实际交付状态。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '收起素材', exact: true }).click();
  assert.equal(await page.locator('.report-source-list').count(), 0);
  await page.getByRole('button', { name: '展开素材', exact: true }).click();
  await page.reload();
  await page.locator('.report-history > button').first().click();
  await page.getByText('手动补充：已核对实际交付状态。', { exact: true }).waitFor();
  await page.setViewportSize({ width: 900, height: 900 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(data, 'report-narrow.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, '窄窗口不横向溢出');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '本月', exact: true }).click();
  await page.getByLabel('开始日期', { exact: true }).fill('2026-11-01');
  await page.getByLabel('结束日期', { exact: true }).fill('2026-11-30');
  await page.getByRole('button', { name: '加载 / 刷新素材', exact: true }).click();
  await page.getByRole('button', { name: '预览素材并生成报告 →', exact: true }).click();
  await page.getByRole('button', { name: '使用本地模板', exact: true }).click();
  await page.locator('.report-document h1').filter({ hasText: '月报 · 资料整理版' }).waitFor();
  assert.equal(calls, 2, '本地模板不调用模型');
  assert.equal(await page.locator('.report-history > button').count(), 2);
  scenario = 'partial';
  await page.getByRole('button', { name: '预览素材并生成报告 →', exact: true }).click();
  await page.getByRole('button', { name: '确认发送并生成', exact: true }).click();
  await page.getByText('已保存的待核对草稿', { exact: true }).waitFor();
  assert.ok((await page.locator('.report-document').innerText()).includes('目录'));
  assert.ok(!(await page.locator('.report-document').innerText()).includes('99%'));
  await page.locator('.report-quality > details > summary').click();
  assert.ok((await page.locator('.report-quality').innerText()).includes('99%'));
  await page.screenshot({ path: path.join(data, 'report-partial.png'), fullPage: true });
  scenario = 'fallback';
  await page.getByRole('button', { name: '预览素材并生成报告 →', exact: true }).click();
  await page.getByRole('button', { name: '确认发送并生成', exact: true }).click();
  await page.getByText('已保存的资料整理版', { exact: true }).waitFor();
  assert.ok((await page.locator('.report-document').innerText()).includes('待整理的原始素材'));
  assert.equal(await page.locator('.report-history > button').count(), 4);
  await page.screenshot({ path: path.join(data, 'report-fallback.png'), fullPage: true });
  scenario = 'unavailable';
  await page.getByRole('button', { name: '预览素材并生成报告 →', exact: true }).click();
  await page.getByRole('button', { name: '确认发送并生成', exact: true }).click();
  await page.getByRole('button', { name: '保存本地资料整理版', exact: true }).waitFor();
  assert.match(await page.locator('.library-error').innerText(), /HTTP 503/);
  const callsBeforeRecovery = calls;
  await page.getByRole('button', { name: '保存本地资料整理版', exact: true }).click();
  await page.getByText('已保存的报告', { exact: true }).waitFor();
  assert.equal(calls, callsBeforeRecovery, '模型不可用时本地恢复不调用模型');
  assert.equal(await page.locator('.report-history > button').count(), 5);
  assert.equal(await page.locator('.library-error').count(), 0);
  await page.screenshot({ path: path.join(data, 'report-recovered.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log('Reports browser smoke passed (mock model):', data);
} finally { await browser.close(); await server.close(); }
