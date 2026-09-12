import { test } from 'node:test';
import assert from 'node:assert/strict';
import { supportsBuiltinSqlite, parseVersion, nodeVersionProblem, NODE_REQUIREMENT } from '../src/env.js';

test('parseVersion 接受带不带 v 前缀的版本号', () => {
  assert.deepEqual(parseVersion('22.13.0'), { major: 22, minor: 13, patch: 0 });
  assert.deepEqual(parseVersion('v25.9.0'), { major: 25, minor: 9, patch: 0 });
  assert.deepEqual(parseVersion('24.0.0-nightly'), { major: 24, minor: 0, patch: 0 });
  assert.equal(parseVersion('不是版本号'), null);
});

test('node:sqlite 免 flag 的版本边界', () => {
  // 官方版本历史：v22.5.0 加入；v23.4.0 与 v22.13.0 起不再需要 --experimental-sqlite
  assert.equal(supportsBuiltinSqlite('22.4.0'), false);
  assert.equal(supportsBuiltinSqlite('22.5.0'), false, 'CI 上 macOS/Windows 的 22.5 就是这样挂的');
  assert.equal(supportsBuiltinSqlite('22.12.0'), false);
  assert.equal(supportsBuiltinSqlite('22.13.0'), true);
  assert.equal(supportsBuiltinSqlite('22.20.1'), true);
  assert.equal(supportsBuiltinSqlite('23.0.0'), false);
  assert.equal(supportsBuiltinSqlite('23.3.0'), false);
  assert.equal(supportsBuiltinSqlite('23.4.0'), true);
  assert.equal(supportsBuiltinSqlite('24.0.0'), true);
  assert.equal(supportsBuiltinSqlite('25.9.0'), true);
  assert.equal(supportsBuiltinSqlite('20.19.0'), false);
});

test('版本不达标时给出可读提示，达标时返回 null', () => {
  assert.equal(nodeVersionProblem('24.1.0'), null);
  const msg = nodeVersionProblem('22.5.0');
  assert.ok(msg?.includes(NODE_REQUIREMENT), '提示里要写清要求');
  assert.ok(msg?.includes('临时办法'), '22.5 可以加 flag 跑起来，应该给出这条出路');
  assert.ok(msg?.includes('node --experimental-sqlite'), '并且要给出可直接复制的命令');
  const old = nodeVersionProblem('20.19.0');
  assert.ok(old?.includes('22.13.0'), '提示里要写清目标版本');
  assert.ok(!old?.includes('临时办法'), '20.x 根本没有 node:sqlite，加 flag 也没用，不该给这条出路');
});

test('当前运行的 Node 必须满足要求（本地自检）', () => {
  assert.equal(nodeVersionProblem(), null, `当前 Node v${process.versions.node} 不满足 ${NODE_REQUIREMENT}`);
});
