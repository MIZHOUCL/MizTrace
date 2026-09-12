import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeOut, buildDay, collectAll } from '../src/day.js';
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
