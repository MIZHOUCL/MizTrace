import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanFiles, isSensitiveName, insideRepo, projectDirOf, projectRootOf, isWorkLike, extensionOf } from '../src/collect/files.js';
import { dayRange, ymd } from '../src/time.js';

// 用本地日期而不是 toISOString().slice(0,10)：后者是 UTC 日期，
// 在 UTC+8 的机器上凌晨跑会把窗口算到前一天，刚创建的文件就落在窗口外。
const RANGE = dayRange(ymd(new Date()), 0);

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miztrace-fs-'));
  const w = (rel, body = 'x') => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
    return p;
  };
  return { root, w };
}

test('敏感文件名识别：该拦的拦住，不该误伤的放过', () => {
  for (const n of ['.env', '.env.production', 'server.pem', 'id_rsa', 'credentials.json', 'vault.kdbx', '.npmrc']) {
    assert.equal(isSensitiveName(n), true, `${n} 应被判为敏感`);
  }
  // 这些是正常源码，用 secret*/token* 前缀通配就会误伤
  for (const n of ['tokenizer.ts', 'secrets.example.json', 'password-strength.js', 'keyboard.tsx', 'monkey.py']) {
    assert.equal(isSensitiveName(n), false, `${n} 不该被判为敏感`);
  }
});

test('insideRepo 只匹配真正的子路径', () => {
  assert.equal(insideRepo('/a/repo/src/x.ts', ['/a/repo']), true);
  assert.equal(insideRepo('/a/repo', ['/a/repo']), true);
  assert.equal(insideRepo('/a/repository/x.ts', ['/a/repo']), false, '不能把 repository 当成 repo 的子目录');
  assert.equal(insideRepo('/b/x.ts', ['/a/repo']), false);
});

test('扫描命中窗口内的文件，跳过敏感文件、点文件与体积黑洞', () => {
  const { root, w } = fixture();
  w('proj/src/a.ts');
  w('proj/src/b.py');
  w('proj/.env');
  w('proj/server.pem');
  w('proj/node_modules/junk/index.js');
  w('proj/.idea/workspace.xml');
  w('proj/dist/bundle.js');
  const { hits, stats } = scanFiles([root], RANGE, { repos: [] });
  const names = hits.map((h) => path.basename(h.path)).sort();
  assert.deepEqual(names, ['a.ts', 'b.py']);
  assert.equal(stats.skippedSensitive, 1, 'server.pem 计入敏感；.env 走点文件分支');
  assert.ok(stats.dirs > 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('落在 git 仓库内的文件交给 git，不重复记账', () => {
  const { root, w } = fixture();
  w('repo/src/a.ts');
  w('loose/b.ts');
  const { hits, stats } = scanFiles([root], RANGE, { repos: [path.join(root, 'repo')] });
  assert.deepEqual(hits.map((h) => path.basename(h.path)), ['b.ts']);
  assert.equal(stats.skippedInRepo, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('mtime 在窗口外、但今天才落到这里的文件按「新出现」记；真正的旧文件不计', () => {
  const { root, w } = fixture();
  const p = w('proj/old.ts');
  const longAgo = new Date('2020-01-01T00:00:00Z');
  fs.utimesSync(p, longAgo, longAgo); // 像解压出来的旧文件：mtime 是 2020，但 inode 是刚才动的
  const { hits } = scanFiles([root], RANGE, { repos: [] });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].created, true);
  assert.ok(Date.parse(hits[0].mtime) >= Date.parse(RANGE.startUtc), '记的是今天，不是 2020');
  // 换一个跟今天无关的窗口：mtime、创建时间、ctime 都不在里面 → 不计
  const past = { startUtc: '2019-01-01T00:00:00.000Z', endUtc: '2019-01-02T00:00:00.000Z' };
  assert.equal(scanFiles([root], past, { repos: [] }).hits.length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('maxFiles 命中上限时显式标记截断，不静默丢弃', () => {
  const { root, w } = fixture();
  for (let i = 0; i < 12; i += 1) w(`proj/f${i}.ts`);
  const { hits, stats } = scanFiles([root], RANGE, { repos: [], maxFiles: 5 });
  assert.equal(hits.length, 5);
  assert.equal(stats.truncated, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('maxDepth 限制递归深度', () => {
  const { root, w } = fixture();
  w('a/b/c/d/e/f/g/deep.ts');
  assert.equal(scanFiles([root], RANGE, { repos: [], maxDepth: 2 }).hits.length, 0);
  assert.equal(scanFiles([root], RANGE, { repos: [], maxDepth: 9 }).hits.length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('projectDirOf 取 root 下第一层目录作为项目', () => {
  // 断言两边都必须走 path.resolve/join 构造：Windows 上 resolve('/code') 会变成 C:\code，
  // 直接写 '/code' 这种 POSIX 字面量会让这条测试只在 macOS/Linux 通过。
  const root = path.resolve(path.join(os.tmpdir(), 'dt-proj-root'));
  const roots = [root];
  assert.equal(projectDirOf(path.join(root, 'foo', 'src', 'a.ts'), roots), path.join(root, 'foo'));
  assert.equal(projectDirOf(path.join(root, 'top.md'), roots), root, '文件直接躺在 root 里就把 root 当项目');
  // 不在任何 root 下时退回文件所在目录
  const outside = path.resolve(path.join(os.tmpdir(), 'dt-other', 'x'));
  assert.equal(projectDirOf(path.join(outside, 'y.ts'), roots), outside);
});

test('projectRootOf 能从 AI 修改文件路径找回实际项目根', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miztrace-project-root-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  const file = path.join(root, 'src', 'index.js');
  fs.writeFileSync(file, '');
  assert.equal(projectRootOf(file), root);
  assert.equal(projectRootOf(path.join(root, 'missing', 'file.js')), root, '文件尚未落盘时仍可按父目录识别');
  fs.rmSync(root, { recursive: true, force: true });
});

test('工作产物白名单：代码/文档/数据留下，应用状态与安装包过滤掉', () => {
  const keep = [
    'main.py', 'app.tsx', 'index.vue', 'query.sql', '周报.xlsx', '方案.docx',
    'README.md', 'config.json', 'schema.yaml', 'Dockerfile', 'Makefile',
    'requirements.txt', 'pdfpage-1.png', 'flow.drawio',
  ];
  for (const n of keep) assert.equal(isWorkLike(n), true, `${n} 应该算工作产物`);

  // 这些是 2026-09-05 那次真实扫描里污染最严重的类型
  const drop = [
    'message.db-shm', 'sign.db-wal', 'first_party_sets.db-journal', 'rich_media.db',
    'NTUSER.DAT{9c0ed8cc-8ae9-11f1-975c-fcb3aaecceca}.TxR.1.regtrans-ms',
    'NTUSER.DAT{9c0ed8cd}.TM.blf', 'BrowserMetrics-spare.pma',
    'pg_control', 'pg_internal.init', 'postmaster.pid', 'postmaster.opts', 'current_logfiles',
    'Config.cfg', 'Local State', 'Last Browser', 'Variations',
    'Microsoft Edge.lnk', '铭利达OA系统.url', 'ChatGPT Installer.exe', 'MizTrace-main (1).zip',
    'postgresql-2026-09-05_075928.log', 'lockfile', 'desktop.ini',
  ];
  for (const n of drop) assert.equal(isWorkLike(n), false, `${n} 应该被过滤`);
});

test('mode:all 时只过滤明确的噪音，其余都留', () => {
  assert.equal(isWorkLike('weird.xyz'), false, 'worklike 模式下未知扩展名不留');
  assert.equal(isWorkLike('weird.xyz', { mode: 'all' }), true);
  assert.equal(isWorkLike('message.db-shm', { mode: 'all' }), false, 'all 模式也不要应用状态');
  assert.equal(isWorkLike('drawing.dwg'), false);
  assert.equal(isWorkLike('drawing.dwg', { extraExtensions: ['dwg'] }), true, '可用配置放宽');
});

test('扫描时应用工作产物过滤，并单独计数', () => {
  const { root, w } = fixture();
  w('proj/main.py');
  w('proj/notes.md');
  w('proj/message.db-shm');
  w('proj/installer.exe');
  w('proj/pg_control');
  const { hits, stats } = scanFiles([root], RANGE, { repos: [] });
  assert.deepEqual(hits.map((h) => path.basename(h.path)).sort(), ['main.py', 'notes.md']);
  assert.equal(stats.skippedNoise, 3);
  fs.rmSync(root, { recursive: true, force: true });
});

test('Office 锁文件 ~$xxx.xlsx 是噪音，正文 xlsx 是工作产物', () => {
  assert.equal(isWorkLike('~$周报9.5.xlsx'), false);
  assert.equal(isWorkLike('~$方案.docx'), false);
  assert.equal(isWorkLike('.~lock.报表.ods#'), false);
  assert.equal(isWorkLike('周报9.5.xlsx'), true);
  assert.equal(isWorkLike('SRM铭利达接口文档.xlsx'), true);
});

test('excludePaths：输出目录与数据目录下的文件不计入（日志不能把自己记进去）', () => {
  const { root, w } = fixture();
  w('journal/2026-09-07.md');
  w('work/notes.md');
  const { hits } = scanFiles([root], RANGE, { repos: [], excludePaths: [path.join(root, 'journal')] });
  assert.deepEqual(hits.map((h) => path.basename(h.path)), ['notes.md']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('修改时间在窗口外、创建时间在窗口内的文件按创建时间记，并标 created（下载 / 解压来的项目）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miztrace-created-'));
  const f = path.join(dir, 'README.md');
  fs.writeFileSync(f, '# x');
  // 把 mtime 拨回十天前，模拟 zip 里带出来的旧时间；创建时间（或 macOS 上的 ctime）仍是刚才
  const old = new Date(Date.now() - 10 * 86_400_000);
  fs.utimesSync(f, old, old);
  const now = Date.now();
  const range = { startUtc: new Date(now - 3_600_000).toISOString(), endUtc: new Date(now + 3_600_000).toISOString() };
  const { hits } = scanFiles([dir], range);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].created, true);
  assert.ok(Date.parse(hits[0].mtime) >= now - 3_600_000, '记的是创建时间，不是十天前的 mtime');
  // 真正十天前的旧文件：创建时间也在窗口外 → 不计
  const g = path.join(dir, 'old.md');
  fs.writeFileSync(g, 'y');
  const past = { startUtc: new Date(now - 20 * 86_400_000).toISOString(), endUtc: new Date(now - 19 * 86_400_000).toISOString() };
  assert.equal(scanFiles([dir], past).hits.length, 0);
});
