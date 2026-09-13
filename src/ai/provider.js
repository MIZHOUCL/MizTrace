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
  let json;
  let text;
  let sent = body;
  // 最多按 400 里的提示改两次参数（max_tokens → max_completion_tokens、去掉 temperature），仍失败就照实报
  for (let attempt = 0; ; attempt += 1) {
    try {
      res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(sent), signal: controller.signal });
    } catch (err) {
      clearTimeout(timer);
      if (err?.name === 'AbortError') throw new Error(`请求超时：模型 ${Math.round(timeoutMs / 1000)} 秒内没有回完（${url}）。可以把「最大输出」调小，或在 config.json 的 ai.timeoutMs 里调大`);
      throw new Error(`连不上模型服务：${scrubSecrets(err?.message ?? String(err))}（${url}）`);
    }
    ({ json, text } = await readJson(res));
    if (res.ok) break;
    const fixed = proto === 'openai' && attempt < 2 ? compatFix(sent, res.status, text) : null;
    if (!fixed) {
      clearTimeout(timer);
      throw httpError(res, text);
    }
    sent = fixed;
  }
  clearTimeout(timer);
  if (!json) throw new Error(`模型服务返回的不是 JSON：${scrubSecrets(text.slice(0, 200))}`);
  // 回包的前几百字：模型回空时，排查全靠它（是 reasoning_content 吃光了预算，还是 choices 干脆是空的）
  const rawExcerpt = scrubSecrets(String(text).replace(/\s+/g, ' ').slice(0, 400));

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
      rawExcerpt,
      maxTokens,
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
    rawExcerpt,
    maxTokens,
  };
}

/**
 * 被截断（finish_reason=length / max_tokens），或干脆回空：都按「输出预算不够」处理，加大预算再试一次。
 * 回空不再要求带思考：有的服务把思考藏起来、finish_reason 也报 stop，只看得到一个空 content。
 * 多试这一次的代价是一次空调用，比让用户自己去猜要调哪个数便宜得多；真是模型名下线，第二次照样空，再按那种情况报。
 */
export function looksLikeBudgetProblem(result) {
  const text = String(result?.text ?? '').trim();
  const cut = result?.finishReason === 'length' || result?.finishReason === 'max_tokens';
  return cut || !text;
}

/**
 * 重试时的预算。带思考的模型（回包里有 reasoning_content）先想再答，想的部分也算在 max_tokens 里，
 * 一篇十几段的中文日记它可能要想上万 token：至少给 16000。普通模型只是正文被截断：至少 8000。
 * 上限 32000，与配置里的上限一致；服务若不接受这么大，调用方会拿到 400 并按第一次的情况报。
 */
export function retryBudget(maxTokens, { reasoning = false } = {}) {
  const cur = Number(maxTokens) || 2000;
  return Math.min(32_000, reasoning ? Math.max(16_000, cur * 4) : Math.max(8000, cur * 2));
}

/**
 * OpenAI 兼容服务之间的参数分歧：OpenAI 的推理模型（o 系列、gpt-5）不认 max_tokens、只认 max_completion_tokens，
 * 也不接受 temperature；不少网关照搬了这套。收到这类 400 就按它说的改一次参数再发，用户不用知道这些。
 * @returns {object|null} 改好的请求体；没法改就 null
 */
export function compatFix(body, status, errorText) {
  if (status !== 400 || !body) return null;
  const t = String(errorText ?? '');
  if ('max_tokens' in body && /max_completion_tokens/i.test(t)) {
    const { max_tokens: mt, ...rest } = body;
    return { ...rest, max_completion_tokens: mt };
  }
  if ('temperature' in body && /temperature/i.test(t) && /unsupported|not support|does not support|not allowed|invalid/i.test(t)) {
    const { temperature: _t, ...rest } = body;
    return rest;
  }
  return null;
}

/**
 * 模型回了东西、但不是能用的 JSON 时，把「它到底回了什么」说清楚。
 * 之前只有一句「模型没有返回 JSON」，用户对着它什么也做不了：是空的？被截断了？回了句人话？模型下线了？
 * @param {{text:string, finishReason?:string|null, reasoning?:boolean, usage?:{output:number}}} result
 * @param {string} model 配置里的模型名
 */
export function explainBadOutput(result, model, { retriedWith } = {}) {
  const text = String(result?.text ?? '').trim();
  const cut = result?.finishReason === 'length' || result?.finishReason === 'max_tokens';
  const budget = retriedWith ? `已自动把「最大输出」加到 ${retriedWith} 重试过一次仍然如此` : `当前「最大输出」${result?.maxTokens ?? '未知'}`;
  const facts = `finish_reason=${result?.finishReason ?? '未知'}${result?.usage?.output ? `，输出 ${result.usage.output} tokens` : ''}${result?.reasoning ? '，回包里带思考内容' : ''}；${budget}`;
  const raw = result?.rawExcerpt ? `\n服务原始回包（前 400 字）：${result.rawExcerpt}` : '';
  if (!text) {
    const tip = result?.reasoning || cut
      ? '这是带思考的模型，思考把输出预算吃光了，正文一个字都没来得及写：把「最大输出」调到 16000 以上，或换一个不带思考的模型（DeepSeek 用 deepseek-chat）'
      : '这个模型名可能已经下线或不可用（名字里带 expires / preview 的尤其如此），换成该服务的稳定模型名再试，或点「测试连接」看它现在回什么';
    return `模型 ${model} 返回了空内容（${facts}）。${tip}。${raw}`;
  }
  const snippet = scrubSecrets(text.replace(/\s+/g, ' ').slice(0, 200));
  if (cut) return `模型 ${model} 的输出被 max_tokens 截断了，没能写完 JSON（${facts}）。把设置里的「最大输出」调大。它写到一半的内容：「${snippet}${text.length > 200 ? '…' : ''}」`;
  return `模型 ${model} 没有按要求返回 JSON，而是回了这段话：「${snippet}${text.length > 200 ? '…' : ''}」。多半是这个模型不听「只输出 JSON」的指令，或者服务把请求转给了别的东西：换个模型再试。`;
}

/** 测试连接：发一条最小请求，回报延迟与模型。永不抛出。 */
export async function testConnection(cfg, deps = {}) {
  try {
    const r = await chat(
      { ...cfg, maxTokens: 64, timeoutMs: Math.min(cfg.timeoutMs ?? 30_000, 30_000) },
      { system: '你是一个连通性探针。', user: '只回复：OK' },
      deps,
    );
    // 带思考的模型在 16 个 token 里只来得及想、来不及答：算连通，但告诉用户它是推理模型
    if (!r.text && r.reasoning) return { ok: true, latencyMs: r.latencyMs, model: r.model, protocol: r.protocol, sample: '', reasoning: true };
    // 200 但什么都没回，也算不通：一个已经下线的模型名可能就是这样，不能报「连通」
    if (!r.text) return { ok: false, error: explainBadOutput(r, cfg.model), protocol: r.protocol, latencyMs: r.latencyMs, model: r.model };
    return { ok: true, latencyMs: r.latencyMs, model: r.model, protocol: r.protocol, sample: r.text.slice(0, 40) };
  } catch (err) {
    return { ok: false, error: scrubSecrets(err?.message ?? String(err)), protocol: detectProtocol(cfg.baseUrl, cfg.protocol) };
  }
}
