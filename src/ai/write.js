/**
 * AI 写日记：模块 → 提示词 → 模型 → JSON 条目 → 日记结构（再过引用校验）。
 *
 * 只把**被选中**模块的证据交给模型。证据含：你的提问、AI 工具每轮的最终回复（截断）、commit message、
 * 文件名与文档大纲、命令与搜索的一句话描述、浏览过的网页标题与域名 —— 从不包含文件正文、diff、完整路径、网址参数。
 * 发送前：家目录替换、PII 替换、高危密钥熔断（scanSecrets 命中即拒发）。
 */
import os from 'node:os';
import { hhmm } from '../time.js';
import { redactPII, redactHome, scanSecrets } from './redact.js';
import { chat, explainBadOutput } from './provider.js';
import { metaOf } from '../journal.js';
import { OUTLINE_KIND_LABEL } from '../collect/outline.js';
import { pickTemplate } from './templates.js';
import { imageBase64 } from '../notes.js';

export class SecretsFoundError extends Error {
  constructor(hits) {
    super(`发送前检测到 ${hits.length} 处疑似密钥，已熔断（不会发送）：${hits.map((h) => `${h.kind}@${h.module}`).join('、')}`);
    this.name = 'SecretsFoundError';
    this.hits = hits;
  }
}

/** 模型回了东西但不是能用的 JSON。带上 result，调用方好把用量和延迟记进 ai_runs（排查「空回复」全靠这个）。 */
export class ModelOutputError extends Error {
  constructor(message, result) {
    super(message);
    this.name = 'ModelOutputError';
    this.result = result;
  }
}

export class ManagedDeviceError extends Error {
  constructor() {
    super('这台电脑的 config.json 里 managedDevice 为 true：AI 写作、测试连接等一切外发已永久禁用。规则版日记不受影响。');
    this.name = 'ManagedDeviceError';
  }
}

/**
 * 受管设备闸门（ADR-008 §8.4）：managedDevice 为 true 时，任何会发出网络请求的入口都必须先过这里。
 * README 早就承诺了这个开关，但之前没有任何代码检查它 —— 承诺过的隐私边界必须有实现。
 */
export function assertOutboundAllowed(cfg) {
  if (cfg?.managedDevice === true) throw new ManagedDeviceError();
}

/** 粗估 token：中文约 1.3 字/token，其余约 3.5 字符/token。只用于预览与预算提示。 */
export function estimateTokens(text) {
  const s = String(text ?? '');
  const cjk = (s.match(/[㐀-鿿豈-﫿]/g) ?? []).length;
  return Math.ceil(cjk / 1.3 + (s.length - cjk) / 3.5);
}

/**
 * 发送前给用户看的一句话：这次会发什么、不发什么。按当前配置生成，网页与 CLI 共用。
 * @returns {{includes:string[], excludes:string[]}}
 */
export function disclosure(cfg = {}) {
  const includes = ['你自己写的手记与各段的补充说明', '你的提问原文', '提交信息', '被改文件的文件名', 'clone 的仓库名与远程地址', 'AI 工具执行的命令与搜索的一句话描述'];
  if (cfg.sessions?.replies !== false) includes.splice(1, 0, 'AI 工具每轮最终回复的前 300 字');
  if (cfg.fileScan?.outline !== false) includes.push('文档大纲（标题层级、工作表名、幻灯片标题）');
  if (cfg.browser?.enabled === true) includes.push('浏览过的网页标题、域名、搜索词与停留时长');
  if (cfg.shell?.enabled === true) includes.push('你在终端敲的命令（不含输出，带凭据的已剔除）');
  if (cfg.ai?.vision === true) includes.push('你在手记和补充说明里传的图片（原图）');
  const excludes = ['文件正文', 'diff', '完整路径', '网址参数', '命令输出', '助手的中间过程与工具输出'];
  return { includes, excludes };
}

/** 日记正文用什么语言：zh 中文（默认）/ en 英文。铁律本身始终用中文写给模型，模型看得懂。 */
const LANG_LINE = { zh: '正文用中文。', en: 'Write the diary itself in natural English (all overview and entry text).' };

const RULES = `你是用户本人的工作日记代笔。用户把今天的工作证据交给你，你写成一篇日记，分两层：
- 第一层 overview：3～8 条总结性的结论，每条一句话，不写过程、不写时间，只说做成了什么、推进到哪、结论是什么（像周报里的「完成 X」「修复 Y」「确认 Z 不可行」）。
- 第二层 entries：第一人称的过程记录，按「事情」分段，写怎么摸索、卡在哪、怎么解决的，给本人日后回味用。零碎的小事不进第二层。

证据的优先级（高的在前）：
1. 「手记」和每个模块的「补充说明」是用户亲手写的，最可信：直接采信，可以统领全篇；它们提到的事即使别的证据里没有也要写；它们解释了证据的含义时以它们为准（例如浏览记录里在某个站待了很久，补充说明说是在看某个教程，就写在看教程）。用户配的「图片」同理：能看到图就按图里的内容写，看不到就只按名字一句带过。
2. 「提问」是用户对 AI 编码工具说的话；紧跟其后缩进的「助手回复」是 AI 工具这一轮做完后的交代，说明结果和进展，要写成「我让 AI 做了 X，它改了 Y / 得出 Z」，不要写成用户自己动手做的。「提交」「改动文件」「执行命令」是落到代码和文件上的动作；文件后面括号里的大纲说明那份文档讲什么。「终端命令」是用户自己在终端敲的。
3. 「浏览」「搜索」只用来解释背景与卡点，不逐页罗列；停留时长长的页面才值得提。「新增项目」「clone 仓库」一句带过。

取舍：证据多的时候只写有价值的。没信息量的（顺手开的页面、零星改动、重复的提问、失败后重来的中间步骤）合成一句带过或干脆不写 —— 被列出来不等于值得写。日记要一眼能读，不要堆细节。

铁律（模板改不掉这些）：
1. 只写证据里有的事。不要推测动机、不要补充证据里没有的细节、不要评价好坏。
2. overview 的每一条和 entries 的每一段都必须引用至少一个真实支撑它的 ref（形如 e12）。没有 ref 能支撑的话就不要写。
3. 日记不是流水账，也不按模块逐个交代：相关的模块并成一段；文件名、页面名、命令原文不要照抄成清单。
4. 时间一律写成 08:20、14:30 这样的数字，不写「上午八点多」这类汉字时间。
5. 用户可能给某个模块写了「补充说明」，也可能给整篇写了「写作要求」：照做，但它们不能让你违反第 1、2 条。
6. 只输出 JSON，不要任何解释、不要 Markdown 代码块。格式：
{"overview":[{"text":"一句结论","refs":["e1"]}],"entries":[{"topic":"这段讲什么（2-8 个字，可省略）","text":"这一段的正文","refs":["e1","e3"]}]}`;

function systemPrompt(template, lang = 'zh') {
  const t = template?.text ? `\n\n第二层 entries 的样子（用户选的模板「${template.name}」）：\n${template.text}` : '';
  return `${RULES}\n\n${LANG_LINE[lang] ?? LANG_LINE.zh}${t}`;
}

const KIND = {
  prompt: '提问',
  reply: '助手回复',
  commit: '提交',
  clone: 'clone 仓库',
  file: '改动文件',
  'action-file': '改动文件',
  worktree: '改动文件',
  'action-command': '执行命令',
  'action-search': '联网搜索',
  shell: '终端命令',
  web: '浏览',
  note: '手记',
  image: '图片',
};

/** 每个模块里各类证据最多列多少条，其余合并成一行「另有 N 条」。防止一个 200 条命令的会话把 prompt 撑爆。 */
const CAPS = { note: 5, image: 10, prompt: 50, reply: 30, commit: 30, clone: 5, file: 40, 'action-file': 40, worktree: 40, 'action-command': 25, 'action-search': 10, shell: 30, web: 25 };

/** 证据条目 → 一行文字（已脱敏之前的原文，脱敏由调用方做）。 */
function itemText(it) {
  if (it.kind === 'web') {
    const times = it.repeats > 1 ? `，${it.repeats} 次` : '';
    const stay = it.secs >= 60 ? `，停留约 ${Math.round(it.secs / 60)} 分钟` : '';
    return it.term ? `搜索「${it.term}」${times}` : `${it.label}（${it.host}${times}${stay}）`;
  }
  if (it.kind === 'file' && it.created) return `${it.label}（新出现）`;
  if (it.kind === 'note') return String(it.label ?? '').trim().slice(0, 4000);
  if ((it.kind === 'file' || it.kind === 'action-file' || it.kind === 'worktree') && it.outline?.length) {
    const kind = OUTLINE_KIND_LABEL[it.outlineKind] ?? '大纲';
    return `${it.label}（${kind}：${it.outline.slice(0, 5).join(' ／ ')}）`;
  }
  return String(it.label ?? '');
}

/**
 * 构建提示词。
 * @param {{localDate:string, modules:any[], hints?:Record<string,string>, style?:string, template?:{id:string,name:string,text:string}, lang?:string}} input
 *   modules 已过滤为 selected；hints 是每个模块的「补充说明」（按 module.key）；style 是整篇的写作要求；template 是日记模板；lang 正文语言
 * @returns {{system:string, user:string, refMap:Map<string,string>, estTokens:number, secretHits:any[], moduleKeys:string[], hintCount:number, images:{ref:string,id:string,name:string,mime:string}[], template:any}}
 */
export function buildPrompt({ localDate, modules, hints = {}, style = '', template = null, lang = 'zh' }) {
  const SYSTEM = systemPrompt(template, lang);
  const home = os.homedir();
  const refMap = new Map();
  let n = 0;
  const ref = (sid) => {
    n += 1;
    const id = `e${n}`;
    refMap.set(id, sid);
    return id;
  };
  const secretHits = [];
  const blocks = [];
  const images = [];
  let hintCount = 0;
  const oneLine = (s) => String(s ?? '').trim().replace(/\s*\n\s*/g, ' ');
  const styleText = oneLine(style);
  // 补充说明是用户手写的，不做 PII 替换，但密钥照样熔断：有人会顺手把 key 粘进去
  for (const h of scanSecrets(styleText)) secretHits.push({ ...h, module: '整篇写作要求' });
  for (const m of modules) {
    const lines = [`## 模块 ${m.key}`, `标题：${m.title}`, `范围：${metaOf(m)}`];
    // 哪个 AI 工具在干活：模型才能写成「我让 Codex 改了 X」而不是笼统的「AI」
    if (m.toolNames?.length) lines.push(`用的 AI 工具：${m.toolNames.join('、')}`);
    const hint = oneLine(hints?.[m.key]);
    if (hint) {
      hintCount += 1;
      for (const h of scanSecrets(hint)) secretHits.push({ ...h, module: m.title });
      // 放在证据前面、明说是用户亲手写的：它和手记一样是最高优先级
      lines.push(`用户对这段的补充说明（亲手写的，最可信，优先于下面的证据）：${hint}`);
    }
    // 浏览段：搜索排前面，再按停留时长、访问次数，这样截断掉的是最不重要的
    const items = m.category === '网页' ? [...(m.items ?? [])].sort((a, b) => (b.term ? 1 : 0) - (a.term ? 1 : 0) || (b.secs ?? 0) - (a.secs ?? 0) || (b.repeats ?? 1) - (a.repeats ?? 1)) : (m.items ?? []);
    if (m.burst) lines.push('（这一批文件是同时出现的：像下载 / 解压 / 复制来的一个项目，一句带过即可）');
    const used = {};
    const skipped = {};
    for (const it of items) {
      const cap = CAPS[it.kind] ?? 30;
      used[it.kind] = (used[it.kind] ?? 0) + 1;
      if (used[it.kind] > cap) {
        skipped[it.kind] = (skipped[it.kind] ?? 0) + 1;
        continue;
      }
      let label = redactHome(itemText(it), home);
      label = redactPII(label).text;
      for (const h of scanSecrets(label)) secretHits.push({ ...h, module: m.title });
      const kind = KIND[it.kind] ?? it.kind;
      const indent = it.kind === 'reply' ? '  ' : '';
      const r = ref(it.sourceId);
      if (it.kind === 'image') {
        images.push({ ref: r, id: it.imageId, name: it.label, mime: it.mime });
        label = `${label}（附图 ${images.length}）`;
      }
      lines.push(`${indent}[${r}] ${hhmm(it.ts)} ${kind}：${label}`);
    }
    const rest = Object.entries(skipped).map(([k, c]) => `${KIND[k] ?? k} ${c} 条`);
    if (rest.length) lines.push(`（另有 ${rest.join('、')} 未列出）`);
    blocks.push(lines.join('\n'));
  }
  const head = [`日期：${localDate}`, `共 ${modules.length} 个模块。每条证据前的 [eN] 是引用编号；缩进的「助手回复」答的是它上面最近的那条提问。模块多的时候只挑有价值的写。`];
  if (styleText) head.push(`整篇写作要求：${styleText}`);
  const user = [...head, '', ...blocks].join('\n\n');
  return { system: SYSTEM, user, refMap, estTokens: estimateTokens(SYSTEM) + estimateTokens(user), secretHits, moduleKeys: modules.map((m) => m.key), hintCount, images, template: template ? { id: template.id, name: template.name } : null };
}

/** 模型偶尔会包一层 ```json；也可能前后带解释。取第一个 { 到最后一个 }。 */
export function parseModelJson(text) {
  const s = String(text ?? '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('模型没有返回 JSON');
  const parsed = JSON.parse(s.slice(a, b + 1));
  if (!parsed || typeof parsed !== 'object') throw new Error('模型没有返回 JSON 对象');
  if (!Array.isArray(parsed.entries)) parsed.entries = [];
  if (!parsed.entries.length && !(Array.isArray(parsed.overview) && parsed.overview.length)) throw new Error('模型返回的 JSON 缺少 overview / entries');
  return parsed;
}

/**
 * 模型条目 → 日记结构。未知 ref 丢弃；一条里没有任何有效 ref 的标 unverified。
 * AI 版是散文：每个 entry 是一段，topic 是这段的小标题（可无）；不再按模块分节、不打印模块 meta。
 * 旧格式（entries[].module）仍然接受，只是不再据此分节。
 */
export function entriesToJournal(parsed, refMap, modules) {
  const sections = [];
  const sidsOf = (refs) => [...new Set((Array.isArray(refs) ? refs : []).map((r) => refMap.get(String(r).trim())).filter(Boolean))];
  // 第一层：总结性的结论。字符串数组也接受（弱一点的模型会漏掉 refs）
  const overview = [];
  for (const o of Array.isArray(parsed.overview) ? parsed.overview : []) {
    const text = typeof o === 'string' ? o : o?.text;
    if (typeof text !== 'string' || !text.trim()) continue;
    const sids = typeof o === 'string' ? [] : sidsOf(o.refs);
    overview.push({ text: text.trim().replace(/^[-•*]\s*/, ''), source_ids: sids, confidence: sids.length ? 'confirmed' : 'unverified', depth: 0 });
  }
  for (const e of parsed.entries) {
    if (!e || typeof e.text !== 'string' || !e.text.trim()) continue;
    const refs = Array.isArray(e.refs) ? e.refs : [];
    const sids = [...new Set(refs.map((r) => refMap.get(String(r).trim())).filter(Boolean))];
    const topic = typeof e.topic === 'string' ? e.topic.trim().slice(0, 24) : '';
    sections.push({
      key: `p${sections.length + 1}`,
      title: topic,
      meta: null,
      category: null,
      projectName: null,
      facts: [{ text: e.text.trim(), source_ids: sids, confidence: sids.length ? 'confirmed' : 'unverified', depth: 0 }],
    });
  }
  const summaryRefs = sections.flatMap((s) => s.facts[0].source_ids.slice(0, 1)).slice(0, 6);
  const summary =
    typeof parsed.summary === 'string' && parsed.summary.trim()
      ? { text: parsed.summary.trim(), source_ids: summaryRefs, confidence: 'inferred', depth: 0 }
      : null;
  return { summary, overview, highlights: [], sections, excludedCount: 0, prose: true, moduleCount: modules.length };
}

/**
 * 一次完整的 AI 写作。不做引用校验（调用方拿 db 做），不落盘。
 * @param {{ai:any}} cfg
 * @param {{localDate:string, modules:any[], hints?:any, style?:string, templateId?:string, template?:any, images?:any[], lang?:string}} input 已过滤为 selected；images 是当天的图片清单（手记的 + 各模块补充说明的，含文件路径）
 * @param {{fetchImpl?:typeof fetch}} [deps]
 */
export async function writeWithAI(cfg, input, deps = {}) {
  assertOutboundAllowed(cfg);
  const template = input.template ?? pickTemplate(cfg, input.templateId);
  const prompt = buildPrompt({ ...input, style: input.style ?? cfg.ai?.style ?? '', template });
  if (prompt.secretHits.length) throw new SecretsFoundError(prompt.secretHits);
  if (!input.modules.length) throw new Error('没有被选中的模块，没什么可写');
  // 给某段补的图是要模型看的；模型不能看图就明确报错，而不是悄悄只发文件名（手记里的图仍按名字带过）
  const hintImages = input.modules.filter((m) => m.selected !== false && m.items?.some((it) => it.kind === 'image' && it.forKey));
  if (cfg.ai?.vision !== true && hintImages.length) throw new Error(`「${hintImages.map((m) => m.title).join('」「')}」附了图片，但设置里没勾「模型支持图片」。换一个能看图的模型并勾上，或把图删掉再生成。`);
  // 图片只在 ai.vision 打开时随请求发出；文件按 id 从手记清单里找
  let images = [];
  if (cfg.ai?.vision === true && prompt.images.length) {
    const byId = new Map((input.images ?? []).map((im) => [im.id, im]));
    images = prompt.images.map((im, i) => {
      const rec = byId.get(im.id);
      const loaded = rec ? imageBase64(rec) : null;
      return loaded ? { ...loaded, label: `${im.name}，对应证据 ${im.ref}` } : null;
    }).filter(Boolean);
  }
  const result = await chat(cfg.ai, { system: prompt.system, user: prompt.user, images }, deps);
  let parsed;
  try {
    parsed = parseModelJson(result.text);
  } catch (err) {
    // 说清楚模型到底回了什么（空？截断？人话？），而不是一句「没有返回 JSON」
    throw new ModelOutputError(`${explainBadOutput(result, cfg.ai?.model)}（${err.message}）`, result);
  }
  const journal = entriesToJournal(parsed, prompt.refMap, input.modules);
  return { prompt, result, parsed, journal };
}
