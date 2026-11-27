/** 日记库直接读取本地存储，不触发采集，也不调用模型。 */
import fs from 'node:fs';
import path from 'node:path';
import { getDayState, setDraft } from './db.js';
import { stripAnnotations } from './journal.js';
import { snapshotJournal } from './journal-history.js';
import { libraryRoots } from './journal-roots.js';
import { MAX_JOURNAL_BYTES, digest, journalError, journalRoot, checkedJournalPath, readJournalFile, replaceJournalFile } from './journal-files.js';
import { listReports, readReport, saveReport } from './report-store.js';

const MAX_ENTRIES = 2000;
const normalize = (s) => String(s ?? '').replace(/\r\n/g, '\n').trimEnd();
const same = (a, b) => normalize(a) === normalize(b);
const titleOf = (md, fallback) => String(md ?? '').match(/^#\s+(.+)$/m)?.[1]?.trim().slice(0, 160) || fallback;
const fileId = (root, relative) => `file:${digest(root).slice(0, 24)}:${Buffer.from(relative).toString('base64url')}`;
const summary = ({ markdown, revision, ...doc }) => doc;

export function validateJournalDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(`${date}T12:00:00Z`)) || new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw journalError('请选择有效日期');
  }
  return date;
}

function fromRow(row, kind) {
  const markdown = kind === 'draft' ? row.draft_md : row.markdown;
  const id = `${kind}:${row.local_date}`;
  return { id, kind, date: row.local_date, title: titleOf(markdown, row.local_date), markdown: markdown ?? '',
    path: kind === 'journal' ? row.out_path : null, updatedAt: row.updated_at,
    revision: digest(JSON.stringify([id, markdown, kind === 'journal' ? row.out_path : row.draft_json])), reviewRequired: true };
}

function fileDocument(cfg, id) {
  const parts = String(id).split(':');
  const root = libraryRoots(cfg).find((p) => digest(p).slice(0, 24) === parts[1]);
  if (!root || parts.length !== 3 || parts[1] !== digest(root).slice(0, 24)) {
    throw journalError('日记目录已变更，请刷新列表后重新打开', 409, 'ROOT_CHANGED');
  }
  const relative = Buffer.from(parts[2], 'base64url').toString('utf8');
  if (fileId(root, relative) !== id) throw journalError('日记标识无效');
  const file = checkedJournalPath(root, relative);
  const data = readJournalFile(file);
  return { id, kind: 'file', date: path.basename(relative).match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? '',
    title: titleOf(data.markdown, path.basename(relative, path.extname(relative))),
    path: file, root, relativePath: relative, ...data, reviewRequired: true };
}

export function readLibraryDocument(db, cfg, id) {
  if (typeof id !== 'string') throw journalError('缺少日记标识');
  if (id.startsWith('report:')) return readReport(db, id);
  if (id.startsWith('file:')) return fileDocument(cfg, id);
  const match = id.match(/^(journal|draft):(\d{4}-\d{2}-\d{2})$/);
  if (!match) throw journalError('日记标识无效');
  const [, kind, date] = match;
  validateJournalDate(date);
  const row = db.prepare(`SELECT * FROM ${kind === 'journal' ? 'journals' : 'day_state'} WHERE local_date = ?`).get(date);
  if (!row || (kind === 'draft' && row.draft_md == null)) throw journalError('没有找到这篇日记，请刷新列表', 404, 'NOT_FOUND');
  return fromRow(row, kind);
}

export function listLibraryDocuments(db, cfg) {
  const warnings = [];
  const documents = [];
  const filesByPath = new Map();
  const roots = libraryRoots(cfg, warnings);
  let visited = 0, bytes = 0, truncated = false, skipped = 0;
  function walk(root, dir, prefix = '', depth = 0) {
    if (depth > 8) { truncated = true; return; }
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { skipped++; return; }
    for (const entry of entries) {
      if (++visited > 10_000 || documents.length >= MAX_ENTRIES || bytes > 32 * 1024 * 1024) { truncated = true; return; }
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.isSymbolicLink()) continue;
      const relative = prefix + entry.name;
      if (entry.isDirectory()) walk(root, path.join(dir, entry.name), relative + '/', depth + 1);
      else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        try {
          const doc = fileDocument(cfg, fileId(root, relative));
          bytes += doc.bytes;
          documents.push(summary(doc));
          filesByPath.set(path.resolve(doc.path), doc);
        } catch { skipped++; }
      }
    }
  }
  for (const root of roots) walk(root, root);
  const journals = db.prepare('SELECT * FROM journals ORDER BY local_date DESC LIMIT ?').all(MAX_ENTRIES + 1);
  const drafts = db.prepare('SELECT * FROM day_state WHERE draft_md IS NOT NULL ORDER BY local_date DESC LIMIT ?').all(MAX_ENTRIES + 1);
  const savedByDate = new Map();
  for (const row of journals.slice(0, MAX_ENTRIES)) {
    const doc = fromRow(row, 'journal');
    savedByDate.set(doc.date, doc);
    const file = row.out_path ? filesByPath.get(path.resolve(row.out_path)) : null;
    // 文件被外部改过时保留数据库版本，让两份不同正文都能找到。
    if (!file || !same(file.markdown, doc.markdown)) documents.push(summary(doc));
  }
  for (const row of drafts.slice(0, MAX_ENTRIES)) {
    const doc = fromRow(row, 'draft');
    const saved = savedByDate.get(doc.date);
    if (!saved || (!same(saved.markdown, doc.markdown) && !same(saved.markdown, stripAnnotations(doc.markdown)))) documents.push(summary(doc));
  }
  if (truncated || journals.length > MAX_ENTRIES || drafts.length > MAX_ENTRIES) warnings.push('列表达到扫描上限（每类 2000 篇、文件 32 MiB、8 层目录）；请缩小日记目录范围。');
  if (skipped) warnings.push(`${skipped} 个文件或目录无法读取，可能超出 512 KiB、不是 UTF-8 或没有访问权限。`);
  documents.push(...listReports(db));
  documents.sort((a, b) => (b.date || b.updatedAt || '').localeCompare(a.date || a.updatedAt || '') || b.updatedAt.localeCompare(a.updatedAt));
  return { documents, warnings, directories: cfg.journalLibrary?.roots ?? [] };
}

export function createLibraryDocument(db, cfg, date) {
  validateJournalDate(date);
  const existing = db.prepare('SELECT * FROM journals WHERE local_date = ?').get(date);
  if (existing) {
    for (const root of libraryRoots(cfg)) {
      if (!existing.out_path) break;
      const relative = path.relative(root, existing.out_path).split(path.sep).join('/');
      try {
        const file = fileDocument(cfg, fileId(root, relative));
        if (same(file.markdown, existing.markdown)) return { document: file, existing: true };
      } catch { /* 导出文件缺失或移出当前目录时打开数据库副本。 */ }
    }
    return { document: fromRow(existing, 'journal'), existing: true };
  }
  // 当天已有独立文件或草稿时直接打开，避免新建按钮意外覆盖已有内容。
  for (const root of libraryRoots(cfg)) {
    if (fs.existsSync(path.join(root, `${date}.md`))) return { document: fileDocument(cfg, fileId(root, `${date}.md`)), existing: true };
  }
  const draft = db.prepare('SELECT * FROM day_state WHERE local_date = ? AND draft_md IS NOT NULL').get(date);
  if (draft) return { document: fromRow(draft, 'draft'), existing: true };
  const now = new Date().toISOString();
  db.prepare('INSERT INTO journals(id, local_date, markdown, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(`journal:${date}`, date, `# ${date}\n\n`, now, now);
  return { document: readLibraryDocument(db, cfg, `journal:${date}`), existing: false };
}

export function saveLibraryDocument(db, cfg, { id, markdown, revision }) {
  if (typeof id === 'string' && id.startsWith('report:')) return saveReport(db, { id, markdown, revision });
  if (typeof markdown !== 'string') throw journalError('正文必须是 Markdown 文本');
  if (Buffer.byteLength(markdown) > MAX_JOURNAL_BYTES) throw journalError('正文不能超过 512 KiB', 413, 'TOO_LARGE');
  const current = readLibraryDocument(db, cfg, id);
  if (!revision || current.revision !== revision) throw journalError('日记已发生变化，你的编辑仍保留在编辑器中。请先导出，再重新打开合并。', 409, 'REVISION_CONFLICT');
  if (current.markdown === markdown) return current;
  snapshotJournal(db, id, current.markdown);
  if (current.kind === 'file') {
    replaceJournalFile(current.path, markdown, current.revision);
    // 已登记的导出文件保持数据库副本同步；不同内容的本地快照仍单独保留。
    const rows = db.prepare('SELECT * FROM journals WHERE out_path = ?').all(current.path);
    for (const row of rows) {
      if (!same(row.markdown, current.markdown)) continue;
      snapshotJournal(db, `journal:${row.local_date}`, row.markdown);
      db.prepare('UPDATE journals SET markdown = ?, updated_at = ? WHERE id = ?').run(markdown, new Date().toISOString(), row.id);
      syncMatchingDraft(db, row.local_date, current.markdown, markdown);
    }
  } else if (current.kind === 'journal') {
    // 数据库副本的编辑仅写本地库；原导出文件保持为单独版本。
    db.prepare('UPDATE journals SET markdown = ?, out_path = NULL, updated_at = ? WHERE local_date = ?')
      .run(markdown, new Date().toISOString(), current.date);
    syncMatchingDraft(db, current.date, current.markdown, markdown);
  } else {
    setDraft(db, current.date, markdown, { source: 'edited', reviewRequired: true });
  }
  return readLibraryDocument(db, cfg, id);
}

function syncMatchingDraft(db, date, before, markdown) {
  const draft = getDayState(db, date);
  if (draft.draftMd != null && (same(draft.draftMd, before) || same(stripAnnotations(draft.draftMd), before))) {
    setDraft(db, date, markdown, { source: 'edited', reviewRequired: true });
  }
}

export function libraryHistory(db, cfg, id, revisionId) {
  readLibraryDocument(db, cfg, id); // 校验目录范围和文档是否存在
  if (revisionId) {
    const row = db.prepare('SELECT id, markdown, created_at AS createdAt FROM journal_revisions WHERE document_id = ? AND id = ?').get(id, Number(revisionId));
    if (!row) throw journalError('没有找到这个历史版本', 404, 'NOT_FOUND');
    return row;
  }
  return { revisions: db.prepare('SELECT id, created_at AS createdAt, reason FROM journal_revisions WHERE document_id = ? ORDER BY id DESC LIMIT 50').all(id) };
}

/** 今日记录保存前比较文件、数据库和草稿；设置切换目录也使旧令牌失效。 */
export function journalSaveRevision(db, cfg, date) {
  validateJournalDate(date);
  const row = db.prepare('SELECT markdown, out_path FROM journals WHERE local_date = ?').get(date) ?? null;
  const draft = getDayState(db, date);
  const root = journalRoot(cfg);
  let file = null;
  if (root) {
    const target = checkedJournalPath(root, `${date}.md`, { missing: true });
    if (fs.existsSync(target)) file = readJournalFile(target).revision;
  }
  return digest(JSON.stringify([cfg.out || null, root, row, draft.draftMd, draft.draftJson, file]));
}
