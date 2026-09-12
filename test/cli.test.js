import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'miztrace.js');

/** 真的起一个子进程跑 CLI：干净的 HOME（没有任何 AI 会话）、独立的数据目录、空的扫描根。 */
function sandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'miztrace-cli-'));
  const home = path.join(base, 'home');
  const root = path.join(base, 'root');
  fs.mkdirSync(home);
  fs.mkdirSync(root);
  const env = { ...process.env, HOME: home, USERPROFILE: home, MIZTRACE_DATA_DIR: path.join(base, 'data') };
  const run = (args) => execFileSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  return { base, root, out: path.join(base, 'out'), run };
}

test('CLI：today 与 week 落到不同文件，week 不覆盖当天日记；重复运行不堆 .bak', () => {
  const { base, root, out, run } = sandbox();
  try {
    const today = run(['today', '--root', root, '--out', out, '--no-files']);
    assert.match(today, /^# \d{4}-\d{2}-\d{2}\n/, 'today 的标题是日期');
    const week = run(['week', '--root', root, '--out', out, '--no-files']);
    assert.match(week, /^# \d{4}-\d{2}-\d{2} ～ \d{4}-\d{2}-\d{2}（7 天汇总）\n/, 'week 的标题写清区间');

    const files = fs.readdirSync(out).sort();
    assert.equal(files.length, 2, `实际文件：${files}`);
    assert.ok(files.some((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)), '当天日记');
    assert.ok(files.some((f) => /^\d{4}-\d{2}-\d{2}-week\.md$/.test(f)), '周汇总单独成文件');

    run(['today', '--root', root, '--out', out, '--no-files']);
    assert.equal(fs.readdirSync(out).filter((f) => f.endsWith('.bak')).length, 0, '内容未变，不该多出备份');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('CLI：--tz 非法时退出码 2 且不落盘', () => {
  const { base, root, out, run } = sandbox();
  try {
    assert.throws(
      () => run(['today', '--root', root, '--out', out, '--tz', 'UTC+8']),
      (err) => err.status === 2 && /无法识别的时区/.test(String(err.stderr)),
    );
    assert.equal(fs.existsSync(out), false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
