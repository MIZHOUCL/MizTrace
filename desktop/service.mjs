/** 独立的 Node 子进程；不依赖 Electron 自带 Node 是否提供 node:sqlite。 */
import { loadConfig } from './core/src/config.js';
import { startServer } from './core/src/server/index.js';
import { applyTimeZone } from './core/src/time.js';

let server;
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  if (server) await server.close();
  process.exit(0);
}
process.on('message', (message) => { if (message?.type === 'shutdown') shutdown(); });
process.on('disconnect', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
try {
  const cfg = loadConfig();
  cfg.effectiveTimezone = applyTimeZone(cfg.timezone);
  server = await startServer({ cfg, port: 0, open: false });
  if (stopping) await shutdown();
  else process.send?.({ type: 'ready', url: server.url, nodeVersion: process.versions.node, sqlite: true });
} catch (error) {
  process.send?.({ type: 'startup-error', message: error.message });
  process.exitCode = 1;
  process.disconnect?.();
}
