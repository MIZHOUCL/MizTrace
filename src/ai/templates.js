/**
 * 日记模板：告诉模型「这篇日记长什么样」。铁律（只写证据里有的、每条带引用）不在模板里，模板改不掉它们。
 * 内置几个，用户在设置里可以改文字、加自己的；改过的按 id 覆盖内置的，删掉自定义的就回到内置。
 */

export const BUILTIN_TEMPLATES = [
  {
    id: 'summary',
    name: '总结型',
    text: '按「事情」分成 3-6 段，每段 2-4 句，讲清做了什么、卡在哪、进展到哪；同一件事跨了几个模块就并成一段。零碎的事（配置改动、顺手看的页面、下载或 clone 了什么）合起来一句带过，不单独成段。',
  },
  {
    id: 'timeline',
    name: '时间线',
    text: '按时间顺序写，上午、下午、傍晚各一到三段，每段开头带上大致时间（写成 08:20 这样的数字），像回放一天。同一时段里的几件小事可以并在一段。',
  },
  {
    id: 'review',
    name: '复盘型',
    text: '分三部分，每部分一到三段：「做了什么」写成果和进展；「卡点与解决」写反复、纠错、绕过去的办法；「还没完成」只写证据里明显没做完的事，没有就写「无」。',
  },
  {
    id: 'brief',
    name: '极简',
    text: '第二层不超过 150 字：一段话说清今天最重要的一两件事和结果，其余全部略去。',
  },
];

/** 内置 + 用户改过 / 加的。用户条目按 id 覆盖内置，顺序保持内置在前。 */
export function templatesOf(cfg) {
  const custom = Array.isArray(cfg?.ai?.templates) ? cfg.ai.templates : [];
  const byId = new Map(BUILTIN_TEMPLATES.map((t) => [t.id, { ...t, builtin: true }]));
  for (const t of custom) {
    if (!t || typeof t !== 'object') continue;
    const id = String(t.id ?? '').trim();
    const text = String(t.text ?? '').trim();
    if (!id || !text) continue;
    const base = byId.get(id);
    byId.set(id, { id, name: String(t.name ?? base?.name ?? id).trim() || id, text, builtin: Boolean(base), modified: Boolean(base) && (base.text !== text || (base.name !== (t.name ?? base.name))) });
  }
  return [...byId.values()];
}

/** 选中的模板：按 id 找，找不到就用第一个（总结型）。 */
export function pickTemplate(cfg, id) {
  const all = templatesOf(cfg);
  const want = String(id ?? cfg?.ai?.template ?? '').trim();
  return all.find((t) => t.id === want) ?? all[0];
}

/**
 * 合并前端提交的模板列表：只存跟内置不一样的、以及自定义的；跟内置一字不差的不落盘。
 * @returns {{id:string,name:string,text:string}[]}
 */
export function normalizeTemplates(incoming) {
  if (!Array.isArray(incoming)) return [];
  const byId = new Map(); // 同一个 id 出现两次，后者为准
  for (const t of incoming) {
    if (!t || typeof t !== 'object') continue;
    const id = String(t.id ?? '').trim().replace(/[^\w-]/g, '').slice(0, 40);
    const name = String(t.name ?? '').trim().slice(0, 40);
    const text = String(t.text ?? '').trim().slice(0, 2000);
    if (!id || !text) continue;
    byId.set(id, { id, name, text });
  }
  const out = [];
  for (const { id, name, text } of byId.values()) {
    const builtin = BUILTIN_TEMPLATES.find((b) => b.id === id);
    if (builtin && builtin.text === text && (!name || builtin.name === name)) continue;
    out.push({ id, name: name || builtin?.name || id, text });
  }
  return out;
}
