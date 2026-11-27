import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { sourceDiscovery } from '../src/server/source-discovery.js';

test('后台来源探测合并并发请求、复用缓存、配置变化和手动刷新重新探测', async () => {
  let runs = 0;
  const discovery = sourceDiscovery({ workerFactory: (cfg) => {
    runs++; assert.equal(cfg.ai, undefined);
    const worker = new EventEmitter(); worker.terminate = () => {};
    setTimeout(() => worker.emit('message', { roots: cfg.roots }), 20);
    return worker;
  } });
  const cfg = { roots: ['a'], ai: { apiKey: 'private' } };
  const task = discovery.get(cfg);
  let responsive = false;
  await new Promise((r) => setImmediate(() => { responsive = true; r(); }));
  assert.ok(responsive);
  const results = await Promise.all([task, discovery.get(cfg)]);
  assert.deepEqual(results[0], results[1]); assert.equal(runs, 1);
  await discovery.get(cfg); assert.equal(runs, 1);
  await discovery.get({ ...cfg, roots: ['b'] }); assert.equal(runs, 2);
  await discovery.get({ ...cfg, roots: ['b'] }, true); assert.equal(runs, 3);
  discovery.close();
});

test('探测超时终止线程，失败后仍可重试', async () => {
  let terminated = 0;
  const discovery = sourceDiscovery({ timeout: 20, workerFactory: () => {
    const worker = new EventEmitter(); worker.terminate = () => { terminated++; }; return worker;
  } });
  await assert.rejects(discovery.get({}), /探测超时/);
  await assert.rejects(discovery.get({}), /探测超时/);
  assert.equal(terminated, 2);
  discovery.close();
});
