import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb, setDraft, setHint } from '../src/db.js';
import { saveJournal } from '../src/day.js';
import { listLibraryDocuments, readLibraryDocument, createLibraryDocument, saveLibraryDocument, libraryHistory, journalSaveRevision } from '../src/journal-library.js';
import { checkedJournalPath, MAX_JOURNAL_BYTES } from '../src/journal-files.js';
import { normalizeLibraryRoots } from '../src/journal-roots.js';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miztrace-library-'));
  const db = openDb(':memory:');
  const cfg = { out: path.join(dir, 'diary') };
  fs.mkdirSync(cfg.out);
  cfg.journalLibrary = { roots: [fs.realpathSync(cfg.out)] };
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { db, cfg, dir };
}
const date = '2026-11-27';
test('日记库目录独立于 out：多目录、嵌套去重、移除撤销访问且保留文件', (t) => {
  const { db, cfg, dir } = setup(t);
  const a = path.join(dir, 'notes'), b = path.join(dir, 'archive');
  fs.mkdirSync(a); fs.mkdirSync(b); fs.mkdirSync(path.join(a, 'nested'));
  fs.writeFileSync(path.join(a, 'hello.md'), '# 同名文件 A');
  fs.writeFileSync(path.join(b, 'hello.md'), '# 同名文件 B');
  fs.writeFileSync(path.join(a, 'nested', 'deep.md'), '# 嵌套文件');
  fs.writeFileSync(path.join(cfg.out, 'not-library.md'), '# 仅导出目录');
  cfg.journalLibrary.roots = normalizeLibraryRoots([a, a, path.join(a, 'nested'), b]);
  assert.equal(cfg.journalLibrary.roots.length, 2);
  let docs = listLibraryDocuments(db, cfg).documents;
  assert.equal(docs.length, 3);
  assert.equal(new Set(docs.map((d) => d.id)).size, 3);
  const removed = docs.find((d) => d.title === '同名文件 A');
  const original = readLibraryDocument(db, cfg, removed.id);
  cfg.out = b;
  assert.equal(readLibraryDocument(db, cfg, removed.id).markdown, original.markdown);
  cfg.journalLibrary.roots = normalizeLibraryRoots([b]);
  assert.throws(() => saveLibraryDocument(db, cfg, { ...original, markdown: '# 修改' }), { status: 409 });
  assert.equal(fs.readFileSync(original.path, 'utf8'), original.markdown);
  assert.equal(listLibraryDocuments(db, cfg).documents.length, 1);
  assert.throws(() => normalizeLibraryRoots(['relative']), { status: 400 });
  assert.throws(() => normalizeLibraryRoots([path.join(a, 'missing')]), { status: 400 });
  assert.throws(() => normalizeLibraryRoots([path.join(a, 'hello.md')]), { status: 400 });
  assert.equal(listLibraryDocuments(db, { out: b }).documents.length, 0);
});
test('日记库合并已保存文件、嵌套文件、本地日记和草稿，保留外部不同版本', (t) => {
  const { db, cfg } = setup(t);
  const file = saveJournal(db, cfg, date, '# 今日记录');
  setDraft(db, date, '# 今日记录', { source: 'rules' });
  fs.mkdirSync(path.join(cfg.out, '2025'));
  fs.writeFileSync(path.join(cfg.out, '2025', '回顾.MD'), '# 去年回顾');
  createLibraryDocument(db, { out: null }, '2026-11-26');
  setDraft(db, '2026-11-25', '# 未保存草稿', { source: 'ai' });
  let result = listLibraryDocuments(db, cfg);
  assert.equal(result.documents.length, 4);
  assert.equal(result.documents.filter((d) => d.date === date).length, 1);
  fs.writeFileSync(file, '# 外部修改');
  result = listLibraryDocuments(db, cfg);
  assert.equal(result.documents.filter((d) => d.date === date).length, 2);
  assert.equal(result.documents.find((d) => d.kind === 'journal' && d.date === date).title, '今日记录');
});

test('无需输出目录或 AI 即可创建、保存本地日记和读取历史', (t) => {
  const { db } = setup(t), cfg = { out: null };
  const { document } = createLibraryDocument(db, cfg, date);
  const saved = saveLibraryDocument(db, cfg, { ...document, markdown: '# 第一篇\n\n手写' });
  assert.equal(saved.markdown, '# 第一篇\n\n手写');
  assert.equal(saved.reviewRequired, true);
  assert.equal(saved.path, null);
  const list = libraryHistory(db, cfg, saved.id).revisions;
  assert.equal(list.length, 1);
  assert.equal(libraryHistory(db, cfg, saved.id, list[0].id).markdown, document.markdown);
  assert.throws(() => saveLibraryDocument(db, cfg, { ...document, markdown: '# 旧窗口' }), { status: 409 });
  assert.equal(createLibraryDocument(db, cfg, date).existing, true);
});

test('文件编辑保留原始备份，同步已登记副本和草稿，不覆盖无关草稿', (t) => {
  const { db, cfg } = setup(t);
  const file = saveJournal(db, cfg, date, '# 正文');
  setDraft(db, date, '# 正文', { source: 'ai' });
  const entry = listLibraryDocuments(db, cfg).documents[0];
  const doc = readLibraryDocument(db, cfg, entry.id);
  const saved = saveLibraryDocument(db, cfg, { ...doc, markdown: '# 人工修订\n\n- [x] 完成' });
  assert.equal(fs.readFileSync(file, 'utf8'), saved.markdown);
  const backup = fs.readdirSync(cfg.out).find((f) => f.endsWith('.bak'));
  assert.equal(fs.readFileSync(path.join(cfg.out, backup), 'utf8'), '# 正文\n');
  assert.equal(db.prepare('SELECT markdown FROM journals').get().markdown, saved.markdown);
  assert.equal(JSON.parse(db.prepare('SELECT draft_json FROM day_state').get().draft_json).source, 'edited');
  setDraft(db, date, '# 新的未采纳草稿', { source: 'ai' });
  saveLibraryDocument(db, cfg, { ...saved, markdown: '# 再改一次' });
  assert.equal(db.prepare('SELECT draft_md FROM day_state').get().draft_md, '# 新的未采纳草稿');
});

test('外部编辑、删除、目录切换及另一个窗口的保存不会被旧版本覆盖', (t) => {
  const { db, cfg, dir } = setup(t);
  const file = path.join(cfg.out, `${date}.md`);
  fs.writeFileSync(file, '# 原版');
  const id = listLibraryDocuments(db, cfg).documents[0].id;
  const doc = readLibraryDocument(db, cfg, id);
  fs.writeFileSync(file, '# 外部编辑');
  assert.throws(() => saveLibraryDocument(db, cfg, { ...doc, markdown: '# 旧页面修改' }), { status: 409 });
  assert.equal(fs.readFileSync(file, 'utf8'), '# 外部编辑');
  const another = path.join(dir, 'another'); fs.mkdirSync(another);
  fs.writeFileSync(path.join(another, `${date}.md`), '# 别的目录');
  assert.throws(() => readLibraryDocument(db, { out: another }, id), { status: 409 });
  fs.unlinkSync(file);
  assert.throws(() => saveLibraryDocument(db, cfg, { ...doc, markdown: '# 重建' }), { status: 404 });
});

test('修改其他手记设置不产生正文冲突，草稿修改会产生冲突', (t) => {
  const { db, cfg } = setup(t);
  setDraft(db, date, '# 草稿', { source: 'ai' });
  const doc = readLibraryDocument(db, cfg, `draft:${date}`);
  setHint(db, date, 'module', '补充要求');
  const saved = saveLibraryDocument(db, cfg, { ...doc, markdown: '# 修订草稿' });
  assert.equal(saved.markdown, '# 修订草稿');
  assert.throws(() => saveLibraryDocument(db, cfg, { ...doc, markdown: '# 旧草稿' }), { status: 409 });
});

test('路径穿越、Windows ADS、非 Markdown 文件不能读取', (t) => {
  const { cfg } = setup(t);
  for (const relative of ['../secret.md', '/secret.md', 'C:/secret.md', 'a\\b.md', 'file:secret.md', 'a.txt', './a.md', 'a//b.md']) {
    assert.throws(() => checkedJournalPath(cfg.out, relative, { missing: true }), { status: 400 });
  }
});

test('跳过符号链接和 junction，保存也不会经由链接写出目录', (t) => {
  const { db, cfg, dir } = setup(t);
  const external = path.join(dir, 'external'); fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, 'private.md'), '# private');
  try { fs.symlinkSync(external, path.join(cfg.out, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (e) { if (e.code === 'EPERM') { t.skip('系统没有符号链接权限'); return; } throw e; }
  assert.equal(listLibraryDocuments(db, cfg).documents.length, 0);
  assert.throws(() => checkedJournalPath(cfg.out, 'linked/private.md'), { status: 400 });
});

test('非法日期、过大文件、非 UTF-8 文件得到明确提示', (t) => {
  const { db, cfg } = setup(t);
  for (const d of ['2026-02-30', '../etc', '2026-13-01', null]) assert.throws(() => createLibraryDocument(db, cfg, d), { status: 400 });
  fs.writeFileSync(path.join(cfg.out, 'large.md'), Buffer.alloc(MAX_JOURNAL_BYTES + 1));
  fs.writeFileSync(path.join(cfg.out, 'invalid.md'), Buffer.from([0xff, 0xfe, 0x00]));
  const result = listLibraryDocuments(db, cfg);
  assert.equal(result.documents.length, 0);
  assert.match(result.warnings.join(''), /2 个/);
});

test('本地日记重启后仍可读取，旧数据库迁移增加快照表', (t) => {
  const { dir } = setup(t);
  const file = path.join(dir, 'persistent.sqlite'), cfg = { out: null };
  let db = openDb(file);
  const doc = createLibraryDocument(db, cfg, date).document;
  saveLibraryDocument(db, cfg, { ...doc, markdown: '# 持久记录' });
  db.close(); db = openDb(file);
  try { assert.equal(readLibraryDocument(db, cfg, doc.id).markdown, '# 持久记录'); assert.equal(libraryHistory(db, cfg, doc.id).revisions.length, 1); }
  finally { db.close(); }
});

test('今日保存令牌能检测库内、文件及目录变化', (t) => {
  const { db, cfg } = setup(t);
  const initial = journalSaveRevision(db, cfg, date);
  setHint(db, date, 'a', '非正文');
  assert.equal(journalSaveRevision(db, cfg, date), initial);
  saveJournal(db, cfg, date, '# 保存');
  assert.notEqual(journalSaveRevision(db, cfg, date), initial);
});
