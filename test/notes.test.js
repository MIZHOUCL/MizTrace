import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.MIZTRACE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'miztrace-notes-'));
const { addImage, removeImage, imageBase64, MAX_IMAGES_PER_DAY } = await import('../src/notes.js');
const { notesModule, buildModules } = await import('../src/modules.js');
const { evidenceFromNotes } = await import('../src/facts.js');
const { buildPrompt, writeWithAI, disclosure } = await import('../src/ai/write.js');
const { chat } = await import('../src/ai/provider.js');
const { listDirs } = await import('../src/server/index.js');

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('手记模块：文字 + 图片，权重最高，默认写进日记；空手记没有模块', () => {
  assert.equal(notesModule({ text: '', images: [] }, '2026-09-10'), null);
  const im = addImage('2026-09-10', { name: '截图.png', mime: 'image/png', data: `data:image/png;base64,${PNG}`, ts: '2026-09-10T03:00:00.000Z' });
  assert.ok(fs.existsSync(im.path));
  const notes = { text: '上午对需求，下午写导出，分页没做完。', updatedAt: '2026-09-10T09:00:00.000Z', images: [im] };
  const m = notesModule(notes, '2026-09-10');
  assert.equal(m.category, '手记');
  assert.equal(m.selected, true);
  assert.equal(m.score, 100);
  assert.equal(m.stats.notes, 1);
  assert.equal(m.stats.images, 1);
  assert.deepEqual(m.items.map((i) => i.kind), ['image', 'note'], '按时间排');
  assert.equal(m.items[0].imageId, im.id);
  const mods = buildModules({ projects: [], gitByProject: new Map(), sessionsByProject: new Map(), filesByProject: new Map(), nowIso: '2026-09-10T12:00:00Z', notes }, { localDate: '2026-09-10' });
  assert.equal(mods[0].key, 'notes@2026-09-10', '手记排在最前');
  const rows = evidenceFromNotes(notes, '2026-09-10', 4);
  assert.deepEqual(rows.map((r) => [r.source_type, r.source_ref]), [['note', '2026-09-10'], ['image', im.id]]);
  removeImage(im);
  assert.equal(fs.existsSync(im.path), false);
  assert.equal(imageBase64(im), null);
});

test('图片限制：类型、大小、张数', () => {
  assert.throws(() => addImage('2026-09-10', { name: 'x.svg', mime: 'image/svg+xml', data: PNG }), /只接受/);
  assert.throws(() => addImage('2026-09-10', { name: 'x.png', mime: 'image/png', data: '' }), /空的/);
  const many = Array.from({ length: MAX_IMAGES_PER_DAY }, (_, i) => ({ id: String(i) }));
  assert.throws(() => addImage('2026-09-10', { name: 'x.png', mime: 'image/png', data: PNG }, many), /最多/);
});

test('提示词：手记标为最可信、图片带附图编号；vision 开了才随请求发原图，两种协议的块形状都对', async () => {
  const im = addImage('2026-09-11', { name: '白板.png', mime: 'image/png', data: PNG, ts: '2026-09-11T03:00:00.000Z' });
  const notes = { text: '今天主要在和供应商开会。', updatedAt: '2026-09-11T09:00:00.000Z', images: [im] };
  const m = notesModule(notes, '2026-09-11');
  const p = buildPrompt({ localDate: '2026-09-11', modules: [m] });
  assert.match(p.system, /「手记」和每个模块的「补充说明」是用户亲手写的/);
  assert.match(p.user, /手记：今天主要在和供应商开会。/);
  assert.match(p.user, /图片：白板\.png（附图 1）/);
  assert.equal(p.images.length, 1);
  assert.equal(p.images[0].id, im.id);
  assert.ok(disclosure({ ai: { vision: true } }).includes.some((s) => s.includes('图片')));
  assert.ok(!disclosure({ ai: { vision: false } }).includes.some((s) => s.includes('图片')));

  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(JSON.parse(init.body));
    const anthropic = /messages$/.test(url);
    const text = JSON.stringify({ summary: 'ok', entries: [{ topic: '会', text: '开了会', refs: ['e1'] }] });
    return new Response(JSON.stringify(anthropic ? { content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1 }, model: 'm' } : { choices: [{ message: { content: text } }], usage: { prompt_tokens: 1, completion_tokens: 1 }, model: 'm' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const base = { localDate: '2026-09-11', modules: [m], images: notes.images };
  await writeWithAI({ ai: { baseUrl: 'https://x/v1', apiKey: 'k', model: 'm', vision: false } }, base, { fetchImpl });
  assert.equal(typeof seen[0].messages[1].content, 'string', 'vision 关着：纯文本');
  await writeWithAI({ ai: { baseUrl: 'https://x/v1', apiKey: 'k', model: 'm', vision: true } }, base, { fetchImpl });
  const oc = seen[1].messages[1].content;
  assert.ok(Array.isArray(oc) && oc.some((b) => b.type === 'image_url' && b.image_url.url.startsWith('data:image/png;base64,')), 'OpenAI 兼容：image_url 块');
  await writeWithAI({ ai: { protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'k', model: 'm', vision: true } }, base, { fetchImpl });
  const ac = seen[2].messages[0].content;
  assert.ok(Array.isArray(ac) && ac.some((b) => b.type === 'image' && b.source.media_type === 'image/png'), 'Anthropic：image 块');
  removeImage(im);
});

test('chat：没有图片时消息仍是字符串', async () => {
  let body;
  const fetchImpl = async (url, init) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }], usage: {} }), { status: 200 });
  };
  await chat({ baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' }, { system: 's', user: 'u', images: [] }, { fetchImpl });
  assert.equal(body.messages[1].content, 'u');
});

test('listDirs：根给盘符 / 家目录，普通目录只列子目录、不列隐藏与体积黑洞，坏路径报错不抛', () => {
  const root = listDirs('');
  assert.equal(root.isRoot, true);
  assert.ok(root.roots.length >= 1);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miztrace-ls-'));
  fs.mkdirSync(path.join(dir, 'b'));
  fs.mkdirSync(path.join(dir, 'a'));
  fs.mkdirSync(path.join(dir, '.hidden'));
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'file.txt'), 'x');
  const r = listDirs(dir);
  assert.deepEqual(r.dirs.map((d) => d.name), ['a', 'b']);
  assert.equal(r.parent, path.dirname(dir));
  const bad = listDirs(path.join(dir, 'nope'));
  assert.ok(bad.error);
  assert.deepEqual(bad.dirs, []);
});
