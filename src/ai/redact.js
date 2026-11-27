/**
 * 发送前的脱敏与熔断（PROJECT_PLAN §8.2）。
 *
 * 两层：
 * 1. scanSecrets —— 命中高危密钥模式就**整段拒发**（熔断），而不是替换后继续。
 *    理由：替换靠正则，漏一个就是真泄露；拒发最多让用户少写一条日记。
 * 2. redactPII —— 邮箱、手机号、IP 这类低危信息做替换。
 *
 * 规则集借鉴 brianruggieri/obsidian-daily-digest（MIT）的 sanitize.ts，见 THIRD_PARTY_NOTICES.md。
 */

export const SECRET_PATTERNS = [
  { kind: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { kind: 'openai-key', re: /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}/ },
  { kind: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { kind: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/ },
  { kind: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: 'stripe-key', re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/ },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  { kind: 'private-key-block', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/ },
  { kind: 'db-url-with-password', re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|mssql):\/\/[^\s:@/]+:[^\s@/]{3,}@/i },
  { kind: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*/ },
  { kind: 'password-assignment', re: /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*["']?[^\s"',;]{8,}/i },
];

/** 命中的密钥只回显前 4 位 + 长度，绝不回显全文。 */
function maskHit(m) {
  const s = String(m);
  return `${s.slice(0, 4)}…（${s.length} 字符）`;
}

/**
 * 扫描高危密钥。返回命中列表；为空表示可以发送。
 * @param {string} text
 * @returns {{kind:string, snippet:string}[]}
 */
export function scanSecrets(text) {
  const hits = [];
  const t = String(text ?? '');
  for (const { kind, re } of SECRET_PATTERNS) {
    const m = t.match(re);
    if (m) hits.push({ kind, snippet: maskHit(m[0]) });
  }
  return hits;
}

const PII_RULES = [
  { name: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, to: '[邮箱]' },
  { name: 'cn-phone', re: /(?<!\d)1[3-9]\d{9}(?!\d)/g, to: '[手机号]' },
  { name: 'cn-id', re: /(?<!\d)\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/g, to: '[身份证号]' },
  { name: 'ipv4', re: /(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?!\d)/g, to: '[IP]' },
];

/**
 * 低危 PII 替换。
 * @param {string} text
 * @returns {{text:string, counts:Record<string,number>}}
 */
export function redactPII(text) {
  let out = String(text ?? '');
  const counts = {};
  for (const r of PII_RULES) {
    out = out.replace(r.re, () => {
      counts[r.name] = (counts[r.name] ?? 0) + 1;
      return r.to;
    });
  }
  return { text: out, counts };
}

/** 把家目录替换成占位符，避免用户名进 prompt。 */
export function redactHome(text, home) {
  if (!home) return text;
  const esc = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(text ?? '').replace(new RegExp(esc, 'g'), '~');
}

/** 把任何字符串里疑似 API key 的部分抹掉（用于错误信息，防止 key 随报错进日志）。 */
export function scrubSecrets(text) {
  let out = String(text ?? '');
  for (const { re } of SECRET_PATTERNS) out = out.replace(new RegExp(re.source, `${re.flags.replace('g', '')}g`), '[已抹除]');
  return out;
}
