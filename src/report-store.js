import crypto from 'node:crypto';
import { digest, journalError, MAX_JOURNAL_BYTES } from './journal-files.js';
import { snapshotJournal } from './journal-history.js';

function document(row) {
  if (!row) throw journalError('报告不存在，请刷新列表', 404, 'NOT_FOUND');
  return { id: row.id, kind: 'report', date: row.end_date, start: row.start_date, end: row.end_date,
    reportKind: row.kind, template: row.template, title: row.title, markdown: row.markdown,
    metadata: JSON.parse(row.metadata_json), createdAt: row.created_at, updatedAt: row.updated_at,
    revision: digest(JSON.stringify([row.markdown, row.updated_at])), reviewRequired: true };
}
export function readReport(db, id) {
  return document(db.prepare('SELECT * FROM reports WHERE id = ?').get(String(id ?? '')));
}
export function listReports(db) {
  return db.prepare(`SELECT id, 'report' AS kind, end_date AS date, start_date AS start,
    end_date AS end, kind AS reportKind, template, title, created_at AS createdAt, updated_at AS updatedAt
    FROM reports ORDER BY updated_at DESC LIMIT 500`).all();
}
export function createReport(db, { kind, start, end, template, title, markdown, metadata = {} }) {
  const id = `report:${crypto.randomUUID()}`, now = new Date().toISOString();
  db.prepare('INSERT INTO reports VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, kind, start, end, template, title, markdown, JSON.stringify(metadata), now, now);
  return readReport(db, id);
}
export function saveReport(db, { id, markdown, revision }) {
  if (typeof markdown !== 'string' || !markdown.trim()) throw journalError('报告正文不能为空');
  if (Buffer.byteLength(markdown) > MAX_JOURNAL_BYTES) throw journalError('报告不能超过 512 KiB', 413);
  const current = readReport(db, id);
  if (revision !== current.revision) throw journalError('报告已在其他位置修改，请先导出当前编辑，再重新打开合并。', 409, 'REVISION_CONFLICT');
  if (markdown === current.markdown) return current;
  snapshotJournal(db, id, current.markdown);
  const title = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim().slice(0, 160) || current.title;
  db.prepare('UPDATE reports SET markdown = ?, title = ?, metadata_json = ?, updated_at = ? WHERE id = ?')
    .run(markdown, title, JSON.stringify({ ...current.metadata, edited: true }), new Date().toISOString(), id);
  return readReport(db, id);
}
