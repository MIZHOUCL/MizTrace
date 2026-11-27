import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeOut, buildDay, collectAll, routeGitResult } from '../src/day.js';
import { openDb, setOverrides } from '../src/db.js';
import { DEFAULTS } from '../src/config.js';
import { dayRange, todayLocalDate } from '../src/time.js';

test('buildDay 可以复用上一次的采集结果：模块一样、勾选与手记照常生效、不再重新扫', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miztrace-day-'));
  process.env.MIZTRACE_DATA_DIR = path.join(root, 'data');
  try {
    fs.writeFileSync(path.join(root, 'a.md'), '# 今天');
    fs.writeFileSync(path.join(root, 'b.md'), '# 明天');
    fs.writeFileSync(path.join(root, 'c.md'), '# 后天');
    const cfg = { ...JSON.parse(JSON.stringify(DEFAULTS)), roots: [root], cutoffHour: 4, sessionDirs: { 'claude-code': [path.join(root, 'none')] }, browser: { enabled: false }, shell: { enabled: false } };
    const flags = { json: true, 'no-files': false };
    const db = openDb(':memory:');
    const range = dayRange(todayLocalDate(4), 4);
    const first = buildDay(cfg, range, flags, db);
    assert.ok(first.modules.length >= 1, '三个刚写的文件至少聚成一个模块');
    const key = first.modules[0].key;
    // 用户戳破一个泡泡后再用缓存的采集结果建一次：不重新扫，但勾选要生效
    setOverrides(db, range.localDate, { [key]: false });
    fs.writeFileSync(path.join(root, 'd.md'), '# 新文件'); // 缓存期内新出现的文件不该被看到
    const second = buildDay(cfg, range, flags, db, { ctx: first.ctx });
    assert.equal(second.ctx, first.ctx, '复用的是同一份采集结果');
    assert.deepEqual(second.modules.map((m) => m.key), first.modules.map((m) => m.key), '模块一致');
    assert.equal(second.modules.find((m) => m.key === key).selected, false, '戳破生效');
    assert.equal(second.ctx.fileScan.hits.some((h) => h.path.endsWith('d.md')), false, '没有重新扫');
    const third = buildDay(cfg, range, flags, db);
    assert.notEqual(third.ctx, first.ctx);
    assert.equal(third.ctx.fileScan.hits.some((h) => h.path.endsWith('d.md')), true, '不给 ctx 就重新扫');
    assert.equal(typeof collectAll, 'function');
    db.close();
  } finally {
    delete process.env.MIZTRACE_DATA_DIR;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writeOut：内容未变不备份，内容变了才留 .bak', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'miztrace-out-'));
  const cfg = { out };
  const flags = { json: true };
  const p = writeOut(cfg, '2026-09-08', '# A', flags);
  assert.equal(path.basename(p), '2026-09-08.md');
  writeOut(cfg, '2026-09-08', '# A', flags);
  writeOut(cfg, '2026-09-08', '# A', flags);
  assert.deepEqual(fs.readdirSync(out), ['2026-09-08.md'], '同一内容跑三次不该出现任何备份');

  writeOut(cfg, '2026-09-08', '# B', flags);
  const files = fs.readdirSync(out).sort();
  assert.equal(files.length, 2, `实际：${files}`);
  assert.ok(files.some((f) => /^2026-09-08\.md\..+\.bak$/.test(f)), '内容变化前先备份旧文件');
  assert.equal(fs.readFileSync(path.join(out, '2026-09-08.md'), 'utf8'), '# B\n');

  assert.equal(writeOut({ out: null }, '2026-09-08', '# C', flags), null, '未配置 out 时不落盘');
  fs.rmSync(out, { recursive: true, force: true });
});

test('buildDay 复用数据库中同一路径的旧项目 id，并重映射本次采集结果', () => {
  const db = openDb(':memory:');
  const rootPath = path.resolve('C:/work/same-project');
  db.prepare('INSERT INTO projects (id, name, root_path, created_at) VALUES (?, ?, ?, ?)').run('old-id', 'same-project', rootPath, '2026-09-01T00:00:00.000Z');
  db.prepare(
    `INSERT INTO evidence (id, source_type, source_ref, project_id, occurred_at, local_date)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('old-evidence', 'file', 'old-file', 'old-id', '2026-09-01T01:00:00.000Z', '2026-09-01');

  const ctx = {
    nowIso: '2026-09-14T02:00:00.000Z',
    sessions: [],
    fileScan: { hits: [] },
    projects: [{ id: 'new-id', name: 'same-project', rootPath }],
    gitByProject: new Map([['new-id', []]]),
    sessionsByProject: new Map([['new-id', []]]),
    filesByProject: new Map([['new-id', []]]),
    shellByProject: new Map([['new-id', []]]),
    projectIdForFile: () => 'new-id',
    projectIdForShell: () => 'new-id',
    web: { pages: [], visits: [] },
    shell: { commands: [] },
  };
  const cfg = { ...JSON.parse(JSON.stringify(DEFAULTS)), excludeProjects: [] };
  const range = dayRange('2026-09-14', 4);

  assert.doesNotThrow(() => buildDay(cfg, range, { json: true }, db, { ctx }));
  assert.equal(ctx.projects[0].id, 'old-id');
  assert.equal(ctx.gitByProject.has('old-id'), true);
  assert.equal(ctx.projectIdForFile('anything'), 'old-id');
  const rows = db.prepare('SELECT id, root_path FROM projects').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'old-id');
  assert.equal(rows[0].root_path, rootPath);
  assert.equal(db.prepare("SELECT project_id FROM evidence WHERE id = 'old-evidence'").get().project_id, 'old-id');
  assert.doesNotThrow(() => buildDay(cfg, range, { json: true }, db, { ctx }), '复用同一 ctx 再生成也应幂等');
  db.close();
});

test('routeGitResult 把单一子项目改动归到子项目，跨子项目提交只归父项目', () => {
  const repo = path.resolve('C:/work/mono');
  const resolveProject = (filePath) => {
    const relative = path.relative(repo, filePath);
    if (relative === 'frontend' || relative.startsWith(`frontend${path.sep}`)) return 'frontend';
    if (relative === 'backend' || relative.startsWith(`backend${path.sep}`)) return 'backend';
    return 'mono';
  };
  const frontCommit = { hash: 'front', files: ['frontend/a.js'] };
  const crossCommit = { hash: 'cross', files: ['frontend/b.js', 'backend/b.js'] };
  const routed = routeGitResult(
    repo,
    { repo, branch: 'main', commits: [frontCommit, crossCommit], dirty: [{ path: 'backend/wip.js' }], arrival: null },
    resolveProject,
  );
  const byProject = new Map(routed.map((entry) => [entry.projectId, entry.result]));

  assert.deepEqual(byProject.get('frontend').commits, [frontCommit]);
  assert.deepEqual(byProject.get('backend').dirty, [{ path: 'backend/wip.js' }]);
  assert.deepEqual(byProject.get('mono').commits, [crossCommit]);
  assert.equal(byProject.get('mono').dirty.length, 0);
});
