import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, upsertEvidence } from '../src/db.js';
import { buildFacts, validateReferences, evidenceFromGit } from '../src/facts.js';
import { buildModules } from '../src/modules.js';
import { dayRange, ymd } from '../src/time.js';
import {
  collectWorkingCopy,
  decodeXmlEntities,
  findWorkingCopies,
  normalizeSvnDate,
  parseInfoXml,
  parseLogXml,
  parseStatusXml,
  parseXml,
  repoPathToRelative,
  workingCopyId,
} from '../src/collect/svn.js';

const RANGE = dayRange(ymd(new Date()), 0);

const INFO_XML = `<?xml version="1.0" encoding="UTF-8"?>
<info>
<entry kind="dir" path="." revision="812">
<url>https://svn.example.com/repo/trunk</url>
<relative-url>^/trunk</relative-url>
<repository>
<root>https://svn.example.com/repo</root>
<uuid>0f8a-1c2b</uuid>
</repository>
<wc-info>
<wcroot-abspath>/home/alice/wc</wcroot-abspath>
</wc-info>
</entry>
</info>`;

const LOG_XML = `<?xml version="1.0" encoding="UTF-8"?>
<log>
<logentry revision="814">
<author>alice</author>
<date>2026-09-15T02:11:33.123456Z</date>
<paths>
<path kind="dir" action="M">/trunk/src</path>
<path kind="file" action="M">/trunk/src/a.js</path>
<path kind="file" action="A">/trunk/src/b&amp;c.js</path>
<path kind="file" action="M">/trunk/README.md</path>
<path kind="file" action="M">/branches/other/x.js</path>
</paths>
<msg>修了 &lt;导出&gt; 的分页 / 顺手调格式</msg>
</logentry>
<logentry revision="813">
<author>bob</author>
<date>2026-09-15T01:00:00.000000Z</date>
<paths>
<path kind="file" action="M">/trunk/src/z.js</path>
</paths>
<msg></msg>
</logentry>
</log>`;

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `miztrace-svn-${tag}-`));
}

function statusXml(target, entries) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<status>
<target path="${target}">
${entries
  .map(
    (e) => `<entry path="${e.path}">
<wc-status props="${e.props ?? 'none'}" item="${e.item}" revision="812">
</wc-status>
</entry>`,
  )
  .join('\n')}
</target>
</status>`;
}

/** 假 svn：按子命令返回固定输出，并记录被调用过哪些命令。 */
function fakeRun(handlers) {
  const calls = [];
  const run = (cwd, args) => {
    calls.push(args);
    const name = args[0];
    if (!Object.prototype.hasOwnProperty.call(handlers, name)) throw new Error(`未预期的 svn 调用：${args.join(' ')}`);
    return handlers[name];
  };
  run.calls = calls;
  return run;
}

test('解析 XML：属性、自闭合标签、转义与数字实体', () => {
  const doc = parseXml('<?xml version="1.0"?><a x="1" y="b&amp;c"><b/><c>文&lt;字 &#65;&#x42;</c></a>');
  const a = doc.children[0];
  assert.equal(a.name, 'a');
  assert.deepEqual(a.attrs, { x: '1', y: 'b&c' });
  // 自闭合标签不能把后面的兄弟节点吞成子节点
  assert.deepEqual(a.children.map((c) => c.name), ['b', 'c']);
  assert.equal(a.children[0].children.length, 0);
  assert.equal(a.children[1].text, '文<字 AB');
  assert.equal(decodeXmlEntities('&lt;&gt;&quot;&apos;&amp;'), '<>"\'&');
  assert.equal(decodeXmlEntities('&unknown;'), '&unknown;', '不认识的实体原样保留');
});

test('normalizeSvnDate 把 6 位小数裁到毫秒', () => {
  assert.equal(normalizeSvnDate('2026-09-15T02:11:33.123456Z'), '2026-09-15T02:11:33.123Z');
  assert.equal(normalizeSvnDate('2026-09-15T02:11:33.1Z'), '2026-09-15T02:11:33.100Z');
  assert.equal(normalizeSvnDate('2026-09-15T02:11:33Z'), '2026-09-15T02:11:33.000Z');
  assert.equal(normalizeSvnDate('不是时间'), null);
});

test('repoPathToRelative 把仓库绝对路径还原成工作副本内的相对路径', () => {
  assert.equal(repoPathToRelative('/trunk/src/a.js', 'trunk'), 'src/a.js');
  assert.equal(repoPathToRelative('/trunk', 'trunk'), null, '工作副本根自身不是文件');
  assert.equal(repoPathToRelative('/branches/other/x.js', 'trunk'), null, '工作副本之外的不算');
  assert.equal(repoPathToRelative('/src/a.js', null), 'src/a.js', '工作副本根就是仓库根');
  assert.equal(repoPathToRelative('', 'trunk'), null);
});

test('workingCopyId 稳定、随路径变化、短', () => {
  const id = workingCopyId('/tmp/a');
  assert.match(id, /^[0-9a-f]{8}$/);
  assert.equal(workingCopyId('/tmp/a'), id);
  assert.notEqual(workingCopyId('/tmp/b'), id);
});

test('parseInfoXml 取仓库地址与工作副本在仓库里的位置', () => {
  assert.deepEqual(parseInfoXml(INFO_XML), {
    url: 'https://svn.example.com/repo/trunk',
    relativeUrl: 'trunk',
    repoRoot: 'https://svn.example.com/repo',
    revision: '812',
  });
  assert.equal(parseInfoXml('<info></info>').url, null);
});

test('parseLogXml 取提交，跳过目录、过滤工作副本外的路径、还原实体', () => {
  const commits = parseLogXml(LOG_XML, { wcRepoPath: 'trunk', wcId: 'abcd1234' });
  assert.equal(commits.length, 2);

  const [first, second] = commits;
  assert.equal(first.revision, 814);
  assert.equal(first.hash, 'svn:r814@abcd1234', '两个仓库的 r814 是两个东西，id 必须带工作副本标识');
  assert.equal(first.sourceType, 'svn-commit');
  assert.equal(first.author, 'alice');
  assert.equal(first.email, null, 'SVN 只给用户名，没有邮箱');
  assert.equal(first.committedAt, '2026-09-15T02:11:33.123Z');
  assert.equal(first.message, '修了 <导出> 的分页 / 顺手调格式');
  assert.deepEqual(first.files, ['src/a.js', 'src/b&c.js', 'README.md'], '目录与工作副本外的路径都要滤掉');
  // svn log 不给行数，要行数就得 svn diff 读正文，违反本项目规矩
  assert.equal(first.additions, 0);
  assert.equal(first.deletions, 0);

  assert.equal(second.message, '', '空提交说明要留成空串而不是 undefined');
  assert.equal(second.author, 'bob');
});

test('parseLogXml 支持按作者过滤（对应 --author）', () => {
  const only = parseLogXml(LOG_XML, { wcRepoPath: 'trunk', wcId: 'x', authorFilter: 'ALICE' });
  assert.equal(only.length, 1);
  assert.equal(only[0].author, 'alice');
  assert.equal(parseLogXml(LOG_XML, { wcRepoPath: 'trunk', wcId: 'x', authorFilter: '查无此人' }).length, 0);
});

test('parseStatusXml 映射状态码，跳过不需要记的条目，并 stat 出真实 mtime', () => {
  const wc = tmpdir('status');
  fs.mkdirSync(path.join(wc, 'sub'));
  fs.writeFileSync(path.join(wc, 'mod.js'), 'x');
  fs.writeFileSync(path.join(wc, 'brand.js'), 'x');
  const xml = statusXml('.', [
    { path: 'mod.js', item: 'modified' },
    { path: 'brand.js', item: 'unversioned' },
    { path: 'gone.js', item: 'missing' },
    { path: 'sub', item: 'unversioned' },
    { path: 'untouched.js', item: 'normal' },
    { path: 'junk.log', item: 'ignored' },
    { path: 'props.js', item: 'none', props: 'modified' },
  ]);
  const dirty = parseStatusXml(xml, wc);
  assert.deepEqual(
    dirty.map((d) => [d.path, d.status]),
    [
      ['mod.js', 'M'],
      ['brand.js', '?'],
      ['gone.js', '!'],
      ['props.js', 'M'],
    ],
  );
  assert.ok(dirty.every((d) => d.sourceType === 'svn-worktree'));
  assert.ok(dirty[0].mtime, '能 stat 到就要给真实 mtime，否则时间线上会全堆在运行那一刻');
  assert.equal(dirty[2].mtime, null, '已删除的文件 stat 不到，属正常');
});

test('parseStatusXml 同时认相对路径与绝对路径的 entry', () => {
  const wc = tmpdir('abs');
  fs.writeFileSync(path.join(wc, 'a.js'), 'x');
  const absolute = path.join(wc, 'a.js');
  const dirty = parseStatusXml(statusXml(wc, [{ path: absolute, item: 'modified' }]), wc);
  assert.equal(dirty.length, 1);
  assert.equal(dirty[0].path, 'a.js', 'svn 在不同平台给出的写法不同，统一成相对路径');
});

test('findWorkingCopies 只认工作副本根，跳过体积黑洞与隐藏目录', () => {
  const root = tmpdir('find');
  const outer = path.join(root, 'outer');
  const inner = path.join(outer, 'nested', 'inner');
  fs.mkdirSync(path.join(outer, '.svn'), { recursive: true });
  fs.mkdirSync(inner, { recursive: true });
  fs.mkdirSync(path.join(inner, '.svn'), { recursive: true });
  fs.mkdirSync(path.join(outer, 'node_modules', 'pkg', '.svn'), { recursive: true });
  fs.mkdirSync(path.join(outer, 'plain'), { recursive: true });

  const found = findWorkingCopies([root]);
  assert.deepEqual(found, [inner, outer].sort(), '嵌套的工作副本各自算一个；node_modules 里的是假的，不算');
});

function wcFixture() {
  const wc = tmpdir('collect');
  fs.mkdirSync(path.join(wc, '.svn'));
  fs.mkdirSync(path.join(wc, 'src'));
  fs.writeFileSync(path.join(wc, 'src', 'a.js'), 'x');
  fs.writeFileSync(path.join(wc, 'src', 'fresh.js'), 'x');
  const old = path.join(wc, 'src', 'old.js');
  fs.writeFileSync(old, 'x');
  // 三天前改的文件：未提交 ≠ 今天改的，不该进今天的日记
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3600 * 1000);
  fs.utimesSync(old, threeDaysAgo, threeDaysAgo);
  return wc;
}

test('collectWorkingCopy：命令、remote 开关、未提交改动的 mtime 过滤', () => {
  const wc = wcFixture();
  const status = statusXml('.', [
    { path: 'src/a.js', item: 'modified' },
    { path: 'src/fresh.js', item: 'unversioned' },
    { path: 'src/old.js', item: 'modified' },
  ]);
  const run = fakeRun({ info: INFO_XML, log: LOG_XML, status });
  const result = collectWorkingCopy(wc, RANGE, { run });

  assert.deepEqual(
    run.calls.map((c) => c[0]),
    ['info', 'log', 'status'],
  );
  assert.ok(
    run.calls.every((c) => c.includes('--non-interactive')),
    '必须有 --non-interactive，否则服务器要凭据时 svn 会停下来等输入，把采集卡死',
  );
  assert.ok(run.calls[1].includes('--xml') && run.calls[1].includes('-v'), 'log 要 XML 且带改动路径');

  assert.equal(result.vcs, 'svn');
  assert.equal(result.branch, 'trunk');
  assert.equal(result.repoUrl, 'https://svn.example.com/repo/trunk');
  assert.equal(result.commits.length, 2);
  assert.deepEqual(
    result.dirty.map((d) => d.path),
    ['src/a.js', 'src/fresh.js'],
    '三天前改过的未提交文件不该出现',
  );
  assert.equal(result.warnings.length, 0);
});

test('collectWorkingCopy：remote=false 时只跑本地的 info 与 status，完全不碰服务器', () => {
  const wc = wcFixture();
  const run = fakeRun({ info: INFO_XML, status: statusXml('.', [{ path: 'src/a.js', item: 'modified' }]) });
  const result = collectWorkingCopy(wc, RANGE, { run, remote: false });

  assert.deepEqual(
    run.calls.map((c) => c[0]),
    ['info', 'status'],
  );
  assert.deepEqual(result.commits, [], '关掉远程就取不到提交记录');
  assert.equal(result.dirty.length, 1, '本地未提交改动照样能记录');
});

test('collectWorkingCopy：svn 命令失败时登记警告而不是抛出去', () => {
  const wc = wcFixture();
  const run = (cwd, args) => {
    if (args[0] === 'info') return INFO_XML;
    if (args[0] === 'log') throw Object.assign(new Error('boom'), { stderr: 'svn: E170013 无法连接版本库' });
    return statusXml('.', [{ path: 'src/a.js', item: 'modified' }]);
  };
  const result = collectWorkingCopy(wc, RANGE, { run });
  assert.equal(result.commits.length, 0);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /无法连接版本库/);
  assert.equal(result.dirty.length, 1, 'log 失败不该连累本地改动');
});

const SVN_RESULT = {
  repo: '/tmp/demo',
  vcs: 'svn',
  id: 'abcd1234',
  branch: 'trunk',
  repoUrl: 'https://svn.example.com/repo/trunk',
  arrival: null,
  commits: [
    {
      hash: 'svn:r814@abcd1234',
      revision: 814,
      sourceType: 'svn-commit',
      author: 'alice',
      email: null,
      committedAt: '2026-09-03T06:00:00.000Z',
      message: '修好了扫描器',
      additions: 0,
      deletions: 0,
      files: ['src/a.ts'],
    },
  ],
  dirty: [{ status: 'M', path: 'src/b.ts', mtime: '2026-09-03T07:00:00.000Z', sourceType: 'svn-worktree' }],
  warnings: [],
};

test('SVN 证据用 svn-commit / svn-worktree 两种类型，与 git 的区分开', () => {
  const rows = evidenceFromGit(SVN_RESULT, 'demo', 4, '2026-09-03T08:00:00.000Z');
  assert.deepEqual(rows.map((r) => r.source_type), ['svn-commit', 'svn-worktree']);
  assert.equal(rows[0].source_ref, 'svn:r814@abcd1234');
  assert.equal(rows[0].local_date, '2026-09-03');
  assert.equal(rows[1].path_alias, 'src/b.ts');

  // git 的结果仍走原来的类型，没有被打扰
  const gitShaped = {
    repo: '/tmp/demo',
    commits: [{ ...SVN_RESULT.commits[0], sourceType: undefined }],
    dirty: [{ ...SVN_RESULT.dirty[0], sourceType: undefined }],
  };
  assert.deepEqual(
    evidenceFromGit(gitShaped, 'demo', 4, '2026-09-03T08:00:00.000Z').map((r) => r.source_type),
    ['commit', 'worktree'],
  );

  // 条目上没有 sourceType 时，由结果级的 vcs 兜底
  assert.deepEqual(
    evidenceFromGit({ ...gitShaped, vcs: 'svn' }, 'demo', 4, '2026-09-03T08:00:00.000Z').map((r) => r.source_type),
    ['svn-commit', 'svn-worktree'],
  );
});

test('SVN 事实与证据严格对得上（端到端，不降级）', () => {
  const db = openDb(':memory:');
  const cutoff = 4;
  const localDate = '2026-09-03';
  for (const row of evidenceFromGit(SVN_RESULT, 'demo', cutoff, '2026-09-03T08:00:00.000Z')) upsertEvidence(db, row);

  const facts = buildFacts(
    {
      projects: [{ id: 'demo', name: 'demo', rootPath: '/tmp/demo' }],
      gitByProject: new Map([['demo', [SVN_RESULT]]]),
      sessionsByProject: new Map(),
      filesByProject: new Map(),
    },
    localDate,
  );
  const res = validateReferences(db, facts, localDate);
  assert.equal(res.downgraded, 0, `不应有降级，missing=${JSON.stringify(res.missing)}`);
  const texts = facts.map((f) => f.text);
  assert.ok(
    texts.some((t) => t === 'SVN r814提交「修好了扫描器」（1 个文件）'),
    `缺 SVN 提交事实：${JSON.stringify(texts)}`,
  );
  assert.ok(texts.some((t) => t.includes('工作副本有未提交改动：src/b.ts')), '缺工作副本事实');
  assert.ok(
    !texts.some((t) => t.includes('+0 −0')),
    'svn log 拿不到行数，不能写出「+0 −0」',
  );
  db.close();
});

test('SVN 的提交与未提交改动都能聚成模块条目', () => {
  const modules = buildModules(
    {
      projects: [{ id: 'demo', name: 'demo', rootPath: '/tmp/demo' }],
      gitByProject: new Map([['demo', [SVN_RESULT]]]),
      sessionsByProject: new Map(),
      filesByProject: new Map(),
      nowIso: '2026-09-03T23:00:00.000Z',
    },
    { localDate: '2026-09-03' },
  );
  assert.equal(modules.length, 1);
  const items = modules[0].items;
  assert.equal(modules[0].stats.commits, 1, 'SVN 提交和 git 提交一样算「提交」');
  assert.ok(
    items.some((i) => i.kind === 'commit' && i.sourceId === 'svn-commit:svn:r814@abcd1234'),
    'kind 仍要留给下游按 commit 处理，只有证据 id 区分来源',
  );
  assert.ok(items.some((i) => i.kind === 'worktree' && i.sourceId.startsWith('svn-worktree:demo:src/b.ts')));
});
