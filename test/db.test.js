import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate, currentVersion, upsertEvidence, evidenceExists, SCHEMA_VERSION } from '../src/db.js';
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
