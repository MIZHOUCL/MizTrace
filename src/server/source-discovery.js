import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { candidateRoots } from '../setup.js';
import { detectProviders } from '../collect/sessions.js';
import { detectBrowsers } from '../collect/browser.js';
import { detectShell } from '../collect/shell.js';
import { findWorkingCopies, svnAvailable } from '../collect/svn.js';

// 探测可能遍历大量目录，在独立线程执行，避免阻塞设置、保存和其他本地 API。
if (!isMainThread) {
  const cfg = workerData;
  parentPort.postMessage({
    candidates: candidateRoots({ sessionDirs: cfg.sessionDirs, cwd: process.cwd(), roots: cfg.rootsConfigured ? cfg.roots : [] }),
    providers: detectProviders(cfg.sessionDirs, cfg.roots),
    browsers: detectBrowsers().map((b) => ({ id: b.id, name: b.name, kind: b.kind, profiles: b.profiles.map((p) => ({ profile: p.profile, readable: p.readable, error: p.error })) })),
    shell: detectShell(cfg),
    svn: { available: svnAvailable(), enabled: cfg.svn?.enabled === true, remote: cfg.svn?.remote !== false, workingCopies: findWorkingCopies(cfg.roots, cfg.svn?.maxDepth ?? 4) },
  });
}

export function sourceDiscovery({ ttl = 300_000, timeout = 15_000, workerFactory = (cfg) => new Worker(new URL(import.meta.url), { workerData: cfg, execArgv: [] }) } = {}) {
  let cache, pending, worker, timer;
  return {
    get(cfg, refresh = false) {
      // AI 凭据不需要进入探测线程，也不影响缓存。
      const input = { roots: cfg.roots, rootsConfigured: cfg.rootsConfigured, sessionDirs: cfg.sessionDirs, shell: cfg.shell, svn: cfg.svn };
      const key = JSON.stringify(input);
      if (pending) return pending.then(() => this.get(cfg, refresh && cache?.key !== key));
      if (!refresh && cache?.key === key && Date.now() - cache.at < ttl) return Promise.resolve(cache.value);
      pending = new Promise((resolve, reject) => {
        worker = workerFactory(input);
        let done = false;
        const finish = (err, value) => {
          if (done) return;
          done = true; clearTimeout(timer); worker?.terminate(); worker = null;
          if (err) reject(err); else { cache = { key, value, at: Date.now() }; resolve(value); }
        };
        timer = setTimeout(() => finish(new Error('来源探测超时；你仍可修改并保存设置，稍后再重试探测。')), timeout);
        worker.once('message', (value) => finish(null, value));
        worker.once('error', (err) => finish(err));
        worker.once('exit', (code) => { if (!done) finish(new Error(`来源探测中断 (${code})`)); });
      }).finally(() => { pending = null; });
      return pending;
    },
    close() { clearTimeout(timer); worker?.terminate(); },
  };
}
