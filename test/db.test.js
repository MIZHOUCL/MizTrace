import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate, currentVersion, upsertEvidence, evidenceExists, SCHEMA_VERSION, getDayState, setNotes } from '../src/db.js';
import { buildFacts, validateReferences, parseSourceId, sourceId, shortLabel } from '../src/facts.js';

const EV = {
  source_type: 'commit',
  source_ref: 'a9c7471aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  project_id: 'demo',
  occurred_at: '2026-09-03T06:22:00.000Z',
  local_date: '2026-09-03',
  level: 'L0',
  excerpt: 'add timezone config',
};

test('迁移可重复执行且版本正确', () => {
  const db = openDb(':memory:');
  assert.equal(currentVersion(db), SCHEMA_VERSION);
  migrate(db);
  migrate(db);
  assert.equal(currentVersion(db), SCHEMA_VERSION);
  db.close();
});

test('同一 (type, ref, date) 重复写入只产生一行', () => {
  const db = openDb(':memory:');
  const a = upsertEvidence(db, EV);
  const b = upsertEvidence(db, EV);
  assert.equal(a.inserted, true);
  assert.equal(b.inserted, false);
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM evidence').get();
  assert.equal(n, 1);
  db.close();
});

test('同一 ref 不同归属日算两条（工作树状态按天记）', () => {
  const db = openDb(':memory:');
  upsertEvidence(db, { ...EV, source_type: 'worktree', source_ref: 'demo:src/a.ts' });
  upsertEvidence(db, { ...EV, source_type: 'worktree', source_ref: 'demo:src/a.ts', local_date: '2026-09-04' });
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM evidence WHERE source_type='worktree'").get();
  assert.equal(n, 2);
  db.close();
});

test('evidenceExists 精确匹配三元组', () => {
  const db = openDb(':memory:');
  upsertEvidence(db, EV);
  assert.equal(evidenceExists(db, 'commit', EV.source_ref, '2026-09-03'), true);
  assert.equal(evidenceExists(db, 'commit', EV.source_ref, '2026-09-04'), false);
  assert.equal(evidenceExists(db, 'session', EV.source_ref, '2026-09-03'), false);
  db.close();
});

test('手记：老数据（一天一条）读出来自动迁成第一条手记，字和图都不丢', () => {
  const db = openDb(':memory:');
  const legacy = JSON.stringify({
    text: '上午对需求，下午写导出。',
    updatedAt: '2026-09-03T09:00:00.000Z',
    images: [{ id: 'i1', name: 'a.png', mime: 'image/png', path: '/x/a.png', ts: '2026-09-03T03:00:00.000Z' }],
  });
  db.prepare('INSERT INTO day_state (local_date, notes_json, updated_at) VALUES (?, ?, ?)').run('2026-09-03', legacy, '2026-09-03T09:00:00.000Z');
  const migrated = getDayState(db, '2026-09-03').notes;
  assert.equal(migrated.entries.length, 1, '老的一天一条 → 一条手记');
  assert.equal(migrated.entries[0].text, '上午对需求，下午写导出。');
  assert.equal(migrated.entries[0].ts, '2026-09-03T09:00:00.000Z');
  assert.equal(migrated.images[0].id, 'i1');
  assert.equal(migrated.images[0].entryId, migrated.entries[0].id, '老图要认领到这条手记上，否则就成了没主的图');

  // 再存一次就落成新格式，多条各自留着
  const saved = setNotes(db, '2026-09-03', { ...migrated, entries: [...migrated.entries, { id: 'b2', text: '傍晚又写了一条', ts: '2026-09-03T10:00:00.000Z' }] });
  assert.equal(saved.entries.length, 2);
  assert.equal(getDayState(db, '2026-09-03').notes.entries.length, 2);

  // 空手记
  assert.deepEqual(getDayState(db, '2026-09-04').notes.entries, []);
  // 指向已不存在的手记的图：去掉 entryId，免得成了孤儿
  const orphan = setNotes(db, '2026-09-05', { entries: [], images: [{ id: 'i9', name: 'x.png', mime: 'image/png', path: '/x/x.png', ts: null, entryId: 'gone' }] });
  assert.equal(orphan.images[0].entryId, undefined);
  db.close();
});
