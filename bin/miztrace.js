#!/usr/bin/env node
// 版本闸门必须跑在 import cli 之前：cli 会静态 import node:sqlite，
// 在低版本 Node 上那一步会直接抛 ERR_UNKNOWN_BUILTIN_MODULE，来不及给提示。
import { nodeVersionProblem } from '../src/env.js';

const problem = nodeVersionProblem();
if (problem) {
  process.stderr.write(`${problem}\n`);
  process.exit(1);
}

let main;
try {
  ({ main } = await import('../src/cli.js'));
} catch (err) {
  if (err?.code === 'ERR_UNKNOWN_BUILTIN_MODULE' || /node:sqlite/.test(err?.message ?? '')) {
    process.stderr.write(`这个 Node 构建没有可用的 node:sqlite：${err.message}\n请升级到 Node 22.13+ 或 24+。\n`);
    process.exit(1);
  }
  throw err;
}

try {
  process.exitCode = (await main()) ?? 0;
} catch (err) {
  process.stderr.write(`miztrace 出错：${err?.message ?? err}\n`);
  process.exitCode = 1;
}
