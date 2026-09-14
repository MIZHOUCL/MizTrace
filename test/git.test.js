import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { collectRepo, filterNestedRepoStatus, findRepos, gitAvailable, MAX_DIRTY, repoArrival, cleanRemote } from '../src/collect/git.js';
import { dayRange, ymd } from '../src/time.js';

const RANGE = dayRange(ymd(new Date()), 0);

function mkrepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miztrace-git-'));
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  g('init', '-q');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'T');
  g('config', 'commit.gpgsign', 'false');
  return { dir, g };
}

test('扫描根目录时保留父仓库下的嵌套仓库', { skip: !gitAvailable() }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miztrace-git-tree-'));
  const parent = path.join(root, 'workspace');
  const childA = path.join(parent, 'app-a');
  const childB = path.join(parent, 'app-b');
  fs.mkdirSync(childA, { recursive: true });
  fs.mkdirSync(childB, { recursive: true });
  for (const dir of [parent, childA, childB]) {
    const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    g('init', '-q');
  }

  assert.deepEqual(findRepos([root]), [parent, childA, childB].sort());
  assert.deepEqual(
    filterNestedRepoStatus(parent, [{ status: '??', path: 'app-a/' }, { status: 'M', path: 'app-b' }, { status: 'M', path: 'README.md' }], [parent, childA, childB]),
    [{ status: 'M', path: 'app-b' }, { status: 'M', path: 'README.md' }],
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('未提交改动：今天碰过的才算，放了几天的不算', { skip: !gitAvailable() }, () => {
  const { dir, g } = mkrepo();
  fs.writeFileSync(path.join(dir, 'a.txt'), '1');
  g('add', 'a.txt');
  g('commit', '-q', '-m', 'init');
  // 今天改的
  fs.writeFileSync(path.join(dir, 'a.txt'), '2');
  // 三天前改的（未提交）
  fs.writeFileSync(path.join(dir, 'old.txt'), 'x');
  const old = new Date(Date.now() - 3 * 86_400_000);
  fs.utimesSync(path.join(dir, 'old.txt'), old, old);
  const r = collectRepo(dir, RANGE);
  const names = r.dirty.map((d) => d.path).sort();
  assert.deepEqual(names, ['a.txt'], `old.txt 三天前改的不该出现，实际：${names}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('未跟踪目录展开成文件，而不是一个 docs/', { skip: !gitAvailable() }, () => {
  const { dir, g } = mkrepo();
  fs.writeFileSync(path.join(dir, 'a.txt'), '1');
  g('add', 'a.txt');
  g('commit', '-q', '-m', 'init');
  fs.mkdirSync(path.join(dir, 'docs'));
  fs.writeFileSync(path.join(dir, 'docs', 'x.md'), 'x');
  fs.writeFileSync(path.join(dir, 'docs', 'y.md'), 'y');
  const r = collectRepo(dir, RANGE);
  const names = r.dirty.map((d) => d.path.replace(/\\/g, '/')).sort();
  assert.deepEqual(names, ['docs/x.md', 'docs/y.md']);
  assert.ok(r.dirty.every((d) => d.mtime), '每个文件都要有真实 mtime');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('MAX_DIRTY 是一个合理的上限常量', () => {
  assert.ok(MAX_DIRTY >= 100 && MAX_DIRTY <= 1000);
});

test('cleanRemote 去掉凭据与 .git 后缀，ssh 与 https 都认', () => {
  assert.equal(cleanRemote('https://user:tok@github.com/MIZHOUCL/MizTrace.git'), 'github.com/MIZHOUCL/MizTrace');
  assert.equal(cleanRemote('git@github.com:a/b.git'), 'github.com/a/b');
  assert.equal(cleanRemote('http://10.10.1.71/gitea/OA/mldEcology'), '10.10.1.71/gitea/OA/mldEcology');
  assert.equal(cleanRemote(''), null);
});

test('今天 init / clone 的仓库能被认出来，昨天的不算', { skip: !gitAvailable() }, () => {
  const { dir, g } = mkrepo();
  g('remote', 'add', 'origin', 'https://x:secret@github.com/a/b.git');
  const arrival = repoArrival(dir, RANGE);
  assert.ok(arrival, '刚 init 的仓库应被判为今天落地');
  assert.equal(arrival.remote, 'github.com/a/b', '远程地址里的凭据不能留下');
  const r = collectRepo(dir, RANGE);
  assert.deepEqual(r.arrival, arrival);
  // 把 .git/description 改回三天前 → 不算今天
  const old = new Date(Date.now() - 3 * 86_400_000);
  fs.utimesSync(path.join(dir, '.git', 'description'), old, old);
  assert.equal(repoArrival(dir, RANGE), null);
});
