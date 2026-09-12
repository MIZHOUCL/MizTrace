/**
 * AI Provider（ADR-005）。整个仓库里**唯一**允许出站网络请求的模块，CI 用 grep 盯着。
 *
 * 按协议而不是按厂商：
 * - openai    ：POST {baseUrl}/chat/completions —— DeepSeek / 智谱 / Moonshot / 通义 / OpenRouter / vLLM / Ollama 全是这个
 * - anthropic ：POST {baseUrl}/v1/messages
 * baseUrl、key、模型名全部由用户在前端自填。
 */
import { scrubSecrets } from './redact.js';

export const PROTOCOLS = ['auto', 'openai', 'anthropic'];

/** 去掉尾部斜杠；空字符串原样返回。 */
export function normalizeBaseUrl(url) {
  return String(url ?? '').trim().replace(/\/+$/, '');
}

/** auto：URL 里带 anthropic 就走 anthropic 协议，否则 openai 兼容。 */
export function detectProtocol(baseUrl, explicit = 'auto') {
  if (explicit && explicit !== 'auto') return explicit;
  let host = '';
  try {
    host = new URL(normalizeBaseUrl(baseUrl)).hostname;
  } catch {
    host = String(baseUrl ?? '');
  }
  return /anthropic/i.test(host) ? 'anthropic' : 'openai';
}

/**
 * OpenAI 兼容端点的 chat/completions 地址。
 * 用户可能只填了域名（https://api.deepseek.com），也可能填到 /v1；都接受。
 */
export function openaiEndpoint(baseUrl) {
  const base = normalizeBaseUrl(baseUrl);
  let u;
  try {
    u = new URL(base);
  } catch {
    throw new Error(`baseUrl 不是合法 URL：${base || '（空）'}`);
  }
  if (/\/chat\/completions$/.test(u.pathname)) return base;
  if (u.pathname === '' || u.pathname === '/') return `${base}/v1/chat/completions`;
  return `${base}/chat/completions`;
}

export function anthropicEndpoint(baseUrl) {
  const base = normalizeBaseUrl(baseUrl) || 'https://api.anthropic.com';
  if (/\/v1\/messages$/.test(base)) return base;
  return `${base}/v1/messages`;
}

function validate(cfg) {
  const problems = [];
  if (!cfg.model) problems.push('未填模型名');
  const proto = detectProtocol(cfg.baseUrl, cfg.protocol);
  if (proto === 'openai' && !cfg.baseUrl) problems.push('OpenAI 兼容协议必须填 baseUrl');
  if (!cfg.apiKey) problems.push('未填 API key');
  if (problems.length) throw new Error(`AI 配置不完整：${problems.join('；')}`);
  return proto;
}

async function readJson(res) {
  const text = await res.text();
  try {
    return { json: JSON.parse(text), text };
  } catch {
    return { json: null, text };
  }
}

function httpError(res, text) {
  const head = scrubSecrets(String(text ?? '').slice(0, 300).replace(/\s+/g, ' '));
  return new Error(`模型服务返回 HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}：${head || '（无正文）'}`);
}

/** 默认超时。写一篇 2000 token 的日记，国内几家模型服务常常要一分多钟；60 秒会把正常的生成掐掉。 */
export const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * 发一次对话请求。
 * @param {{protocol?:string, baseUrl:string, apiKey:string, model:string, maxTokens?:number, temperature?:number, timeoutMs?:number}} cfg
 * @param {{system:string, user:string, images?:{mime:string,data:string,label?:string}[]}} msg
 *   images：用户手记里的图片（base64），只有 ai.vision 打开时调用方才会传；两种协议都按各自的多模态块拼进 user 消息
 * @param {{fetchImpl?:typeof fetch}} [deps] 测试时注入
 * @returns {Promise<{text:string, usage:{input:number,output:number}, model:string, latencyMs:number, protocol:string, finishReason:string|null, reasoning:boolean}>}
 *   finishReason：模型为什么停（length = 被 max_tokens 截断）；reasoning：回包里带了思考内容（推理模型）
 */
export async function chat(cfg, msg, deps = {}) {
  const proto = validate(cfg);
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('当前 Node 没有全局 fetch');
  const controller = new AbortController();
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  const maxTokens = cfg.maxTokens ?? 2000;

  const images = Array.isArray(msg.images) ? msg.images.filter((i) => i && i.mime && i.data) : [];
  let url;
  let headers;
  let body;
  if (proto === 'anthropic') {
    url = anthropicEndpoint(cfg.baseUrl);
    headers = { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' };
    // 不带 temperature：新一代 Anthropic 模型不接受采样参数，带了会 400
    const content = images.length
      ? [...images.flatMap((im, i) => [{ type: 'text', text: `附图 ${i + 1}${im.label ? `：${im.label}` : ''}` }, { type: 'image', source: { type: 'base64', media_type: im.mime, data: im.data } }]), { type: 'text', text: msg.user }]
      : msg.user;
    body = { model: cfg.model, max_tokens: maxTokens, system: msg.system, messages: [{ role: 'user', content }] };
  } else {
    url = openaiEndpoint(cfg.baseUrl);
    headers = { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` };
    const content = images.length
      ? [...images.flatMap((im, i) => [{ type: 'text', text: `附图 ${i + 1}${im.label ? `：${im.label}` : ''}` }, { type: 'image_url', image_url: { url: `data:${im.mime};base64,${im.data}` } }]), { type: 'text', text: msg.user }]
      : msg.user;
    body = {
      model: cfg.model,
      max_tokens: maxTokens,
      temperature: cfg.temperature ?? 0.4,
      messages: [
        { role: 'system', content: msg.system },
        { role: 'user', content },
      ],
    };
  }

  let res;
  try {
    res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    if (err?.name === 'AbortError') throw new Error(`请求超时：模型 ${Math.round(timeoutMs / 1000)} 秒内没有回完（${url}）。可以把「最大输出」调小，或在 config.json 的 ai.timeoutMs 里调大`);
    throw new Error(`连不上模型服务：${scrubSecrets(err?.message ?? String(err))}（${url}）`);
  }
  clearTimeout(timer);
  const { json, text } = await readJson(res);
  if (!res.ok) throw httpError(res, text);
  if (!json) throw new Error(`模型服务返回的不是 JSON：${scrubSecrets(text.slice(0, 200))}`);

  const latencyMs = Date.now() - started;
  if (proto === 'anthropic') {
    const blocks = Array.isArray(json.content) ? json.content : [];
    const parts = blocks.filter((b) => b?.type === 'text').map((b) => b.text);
    if (json.stop_reason === 'refusal') throw new Error('模型拒绝了这次请求（stop_reason=refusal）');
    return {
      text: parts.join('\n').trim(),
      usage: { input: json.usage?.input_tokens ?? 0, output: json.usage?.output_tokens ?? 0 },
      model: json.model ?? cfg.model,
      latencyMs,
      protocol: proto,
      finishReason: json.stop_reason ?? null,
      reasoning: blocks.some((b) => b?.type === 'thinking' || b?.type === 'redacted_thinking'),
    };
  }
  const choice = json.choices?.[0];
  const message = choice?.message ?? choice?.delta ?? {};
  const content = message.content ?? choice?.text; // 个别网关按旧的 completions 形状回 text
  const textOut = typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => (typeof c === 'string' ? c : c?.text ?? '')).join('') : '';
  if (!textOut && json.error) throw new Error(`模型服务报错：${scrubSecrets(JSON.stringify(json.error).slice(0, 300))}`);
  const reasoningText = message.reasoning_content ?? message.reasoning ?? null;
  return {
    text: textOut.trim(),
    usage: { input: json.usage?.prompt_tokens ?? 0, output: json.usage?.completion_tokens ?? 0 },
    model: json.model ?? cfg.model,
    latencyMs,
    protocol: proto,
    finishReason: choice?.finish_reason ?? null,
    reasoning: typeof reasoningText === 'string' && reasoningText.trim().length > 0,
  };
}

/**
 * 模型回了东西、但不是能用的 JSON 时，把「它到底回了什么」说清楚。
 * 之前只有一句「模型没有返回 JSON」，用户对着它什么也做不了：是空的？被截断了？回了句人话？模型下线了？
 * @param {{text:string, finishReason?:string|null, reasoning?:boolean, usage?:{output:number}}} result
 * @param {string} model 配置里的模型名
 */
export function explainBadOutput(result, model) {
  const text = String(result?.text ?? '').trim();
  const cut = result?.finishReason === 'length' || result?.finishReason === 'max_tokens';
  const tips = [];
  if (!text) {
    if (result?.reasoning || cut) tips.push('模型把输出预算用在了思考上或还没写完就被截断：把设置里的「最大输出」调大（例如 8000），或换一个不带思考的模型（如 deepseek-chat）');
    else tips.push('模型服务返回了空内容：这个模型名可能已经下线或不可用（名字里带 expires / preview 的尤其如此），换成该服务的稳定模型名再试，或点「测试连接」看它现在回什么');
    return `模型返回了空内容（finish_reason=${result?.finishReason ?? '未知'}${result?.usage?.output ? `，输出 ${result.usage.output} tokens` : ''}）。${tips.join('；')}。`;
  }
  const snippet = scrubSecrets(text.replace(/\s+/g, ' ').slice(0, 200));
  if (cut) return `模型的输出被 max_tokens 截断了，没能写完 JSON。把设置里的「最大输出」调大（当前模型 ${model}）。它写到一半的内容：「${snippet}${text.length > 200 ? '…' : ''}」`;
  return `模型没有按要求返回 JSON，而是回了这段话：「${snippet}${text.length > 200 ? '…' : ''}」。多半是这个模型（${model}）不听「只输出 JSON」的指令，或者服务把请求转给了别的东西：换个模型再试。`;
}

/** 测试连接：发一条最小请求，回报延迟与模型。永不抛出。 */
export async function testConnection(cfg, deps = {}) {
  try {
    const r = await chat(
      { ...cfg, maxTokens: 16, timeoutMs: Math.min(cfg.timeoutMs ?? 30_000, 30_000) },
      { system: '你是一个连通性探针。', user: '只回复：OK' },
      deps,
    );
    // 200 但什么都没回，也算不通：一个已经下线的模型名可能就是这样，不能报「连通」
    if (!r.text) return { ok: false, error: explainBadOutput(r, cfg.model), protocol: r.protocol, latencyMs: r.latencyMs, model: r.model };
    return { ok: true, latencyMs: r.latencyMs, model: r.model, protocol: r.protocol, sample: r.text.slice(0, 40) };
  } catch (err) {
    return { ok: false, error: scrubSecrets(err?.message ?? String(err)), protocol: detectProtocol(cfg.baseUrl, cfg.protocol) };
  }
}
