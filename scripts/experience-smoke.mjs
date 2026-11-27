/** 可选的浏览器回归；传入本机 Playwright 的 index.mjs，不给核心增加依赖。 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { startServer } from '../src/server/index.js';
import { DEFAULTS, defaultSessionDirs } from '../src/config.js';
const { chromium } = await import(pathToFileURL(process.argv[2]).href);
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'miztrace-experience-'));
const folders = ['日记', '项目笔记'].map((p) => path.join(data, p));
for (const p of folders) fs.mkdirSync(p);
fs.mkdirSync(path.join(folders[1], '归档'));
fs.writeFileSync(path.join(folders[0], '2026-11-27.md'), '# 日记库体验优化\n\n## 今天完成\n\n- [x] 独立管理多个日记目录\n- [x] 列表收起与展开\n- [x] 应用内更新\n\n| 功能 | 体验 |\n| --- | --- |\n| Markdown | 编辑与预览 |\n| 历史记录 | 随时查阅 |');
fs.writeFileSync(path.join(folders[1], '归档', '设计.md'), '# 项目设计笔记\n\n文件保留在自己选择的目录里。');
const cfg = structuredClone(DEFAULTS);
Object.assign(cfg, { roots: [data], rootsConfigured: true, setupDone: true, out: null, sessionDirs: Object.fromEntries(Object.keys(defaultSessionDirs()).map((k) => [k, [path.join(data, 'missing')]])), fileScan: { enabled: false }, managedDevice: true });
process.env.MIZTRACE_DATA_DIR = data;
const server = await startServer({ cfg, port: 0, dbFile: path.join(data, 'test.db') });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(({ folders }) => {
    localStorage.setItem('mt_page', 'journals');
    let listener;
    let state = { phase: 'idle', current: '0.4.0', autoCheck: true, release: null, error: '', managed: false };
    const receive = (patch) => { state = { ...state, ...patch }; listener?.(state); return state; };
    window.__updateDownloads = 0;
    window.miztraceDesktop = { chooseDirectories: async () => folders, updates: {
      state: async () => state,
      onState: (fn) => { listener = fn; return () => { listener = null; }; },
      check: async () => receive({ phase: 'available', release: { version: '0.5.0', date: '2026-11-27T08:00:00Z', notes: '## 更新体验验证\n\n- 多目录日记库\n- 更流畅的设置\n\n<script>window.__unsafe = true</script>', bytes: 198000000 } }),
      download: async () => { window.__updateDownloads++; return receive({ phase: 'downloaded' }); },
      install: async () => window.dispatchEvent(new Event('miztrace-before-update', { cancelable: true })) ? receive({ phase: 'installing' }) : receive({ phase: 'downloaded', error: '请先保存当前内容' }),
      setAutoCheck: async (enabled) => receive({ autoCheck: enabled }),
    } };
  }, { folders });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // 保持来源请求未完成，确认设置窗不再等探测。
  let releaseSources;
  await page.route('**/api/sources', async (route) => {
    await new Promise((r) => { releaseSources = r; });
    await route.fulfill({ json: { candidates: [], providers: [], browsers: [], svn: { workingCopies: [] } } });
  });
  await page.goto(server.url);
  await page.getByRole('button', { name: '管理日记目录 ↗', exact: true }).waitFor();
  const start = Date.now();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.locator('#st-title').waitFor({ timeout: 1000 });
  console.log('Settings visible in', Date.now() - start, 'ms while discovery is pending');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.waitForTimeout(50); releaseSources();
  await page.unrouteAll({ behavior: 'wait' });
  await page.getByRole('button', { name: '管理日记目录 ↗', exact: true }).click();
  await page.getByRole('button', { name: '＋ 选择文件夹…', exact: true }).click();
  assert.equal(await page.locator('.library-roots li').count(), 2);
  await page.screenshot({ path: path.join(data, 'directories.png'), fullPage: true });
  await page.getByRole('button', { name: '保存目录', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.journal-entry').length === 2);
  assert.equal(cfg.out, null);
  await page.locator('.journal-entry').filter({ hasText: '日记库体验优化' }).click();
  const editor = page.getByRole('textbox', { name: 'Markdown 正文' });
  await editor.waitFor();
  const wide = await page.locator('.journal-workspace').boundingBox();
  await page.getByRole('button', { name: '收起日记列表', exact: true }).click();
  const expanded = await page.locator('.journal-workspace').boundingBox();
  assert.ok(expanded.width > wide.width + 150);
  await page.screenshot({ path: path.join(data, 'collapsed.png'), fullPage: true });
  await page.reload();
  await page.getByRole('button', { name: '展开日记列表', exact: true }).click();
  await page.locator('.journal-entry').filter({ hasText: '日记库体验优化' }).click();
  await editor.fill('# 未保存的修改');
  assert.equal(await page.evaluate(() => window.dispatchEvent(new Event('miztrace-before-update', { cancelable: true }))), false);
  await page.getByRole('button', { name: '管理日记目录 ↗', exact: true }).click();
  await page.locator('.library-roots li button').first().click();
  await page.getByRole('button', { name: '保存目录', exact: true }).click();
  await page.getByText('请先保存当前日记的修改，再更改目录。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await editor.inputValue(), '# 未保存的修改');
  await page.getByRole('button', { name: '检查更新', exact: true }).click();
  await page.getByRole('button', { name: '下载更新', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__updateDownloads), 0);
  assert.equal(await page.evaluate(() => window.__unsafe), undefined);
  assert.ok((await page.locator('.update-modal').innerText()).includes('2026'));
  const modalBounds = await page.locator('.update-modal').boundingBox();
  assert.ok(modalBounds.y >= 0 && modalBounds.y + modalBounds.height <= 1000, 'Update modal must fit the window');
  await page.screenshot({ path: path.join(data, 'updates.png'), fullPage: true });
  await page.getByRole('button', { name: '下载更新', exact: true }).click();
  await page.getByRole('button', { name: '重启并更新', exact: true }).click();
  await page.getByText('请先保存当前内容', { exact: true }).waitFor();
  await page.getByRole('button', { name: '稍后重启', exact: true }).click();
  await editor.press('Control+s');
  await page.getByText('已保存到本机', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.dispatchEvent(new Event('miztrace-before-update', { cancelable: true }))), true);
  assert.equal(fs.readFileSync(path.join(folders[0], '2026-11-27.md'), 'utf8'), '# 未保存的修改');
  await page.getByRole('button', { name: '管理日记目录 ↗', exact: true }).click();
  await page.locator('.library-roots li button').first().click();
  await page.getByRole('button', { name: '保存目录', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.journal-entry').length === 1);
  assert.ok(fs.existsSync(path.join(folders[0], '2026-11-27.md')));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(data, 'mobile.png'), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
  console.log('PASS folder selection/removal, collapse persistence, dirty guard, manual updates, safe release notes, responsive layout');
  console.log('Screenshots:', data);
} finally { await browser.close(); await server.close(); }
