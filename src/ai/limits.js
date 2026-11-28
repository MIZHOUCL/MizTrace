/** 模型请求的等待时间独立于输出 token 预算；覆盖连接和完整响应读取。 */
export const DEFAULT_TIMEOUT_MS = 180_000;

export function normalizeTimeoutMs(value) {
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? Math.round(Math.max(15_000, Math.min(900_000, ms))) : DEFAULT_TIMEOUT_MS;
}
