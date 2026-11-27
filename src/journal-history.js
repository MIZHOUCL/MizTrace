/** 每次替换正文前保留快照；快照不代表其中的事实经过核验。 */
export function snapshotJournal(db, id, markdown, reason = 'before-edit') {
  if (typeof markdown !== 'string') return;
  const last = db.prepare('SELECT markdown FROM journal_revisions WHERE document_id = ? ORDER BY id DESC LIMIT 1').get(id);
  if (last?.markdown === markdown) return;
  db.prepare('INSERT INTO journal_revisions(document_id, markdown, reason, created_at) VALUES (?, ?, ?, ?)')
    .run(id, markdown, reason, new Date().toISOString());
}
