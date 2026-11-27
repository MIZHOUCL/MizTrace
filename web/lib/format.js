/** 文案与小工具：把数据说成句子，而不是拼接标签。中英文都从这里出，看 lang。 */
import { lang, t } from './i18n.js';

const en = () => lang.value === 'en';

export const CATS = ['手记', '代码', '文档', '数据', 'AI会话', '终端', '网页', '其他', '杂项'];
export const CAT_VAR = { 手记: 'note', 代码: 'code', 文档: 'doc', 数据: 'data', AI会话: 'ai', 终端: 'term', 网页: 'web', 其他: 'other', 杂项: 'misc' };
const CAT_ZH = { 手记: '手记', 代码: '代码', 文档: '文档', 数据: '数据', AI会话: 'AI 会话', 终端: '终端', 网页: '网页', 其他: '其他', 杂项: '杂项' };
const CAT_EN = { 手记: 'Notes', 代码: 'Code', 文档: 'Docs', 数据: 'Data', AI会话: 'AI chat', 终端: 'Terminal', 网页: 'Web', 其他: 'Other', 杂项: 'Misc' };
const KIND_ZH = { prompt: '提问', reply: '回复', commit: '提交', clone: 'clone', file: '改动', 'action-file': '改动', worktree: '改动', 'action-command': '命令', 'action-search': '搜索', shell: '终端', web: '浏览', note: '手记', image: '图片' };
const KIND_EN = { prompt: 'ask', reply: 'reply', commit: 'commit', clone: 'clone', file: 'edit', 'action-file': 'edit', worktree: 'edit', 'action-command': 'cmd', 'action-search': 'search', shell: 'shell', web: 'visit', note: 'note', image: 'image' };
const OUTLINE_ZH = { headings: '标题', sheets: '工作表', slides: '幻灯片', title: '首行', columns: '列', statements: '语句' };
const OUTLINE_EN = { headings: 'headings', sheets: 'sheets', slides: 'slides', title: 'first line', columns: 'columns', statements: 'statements' };
/** 模板里按 CAT_WORD[c] 取：返回的是随语言变的代理对象。 */
export const CAT_WORD = new Proxy({}, { get: (_, k) => (en() ? CAT_EN : CAT_ZH)[k] });
export const KIND_LABEL = new Proxy({}, { get: (_, k) => (en() ? KIND_EN : KIND_ZH)[k] });
export const OUTLINE_LABEL = new Proxy({}, { get: (_, k) => (en() ? OUTLINE_EN : OUTLINE_ZH)[k] });
/** 后端给的项目名有两个是固定的伪项目：随语言换个说法。 */
export function projectWords(name) {
  if (!en()) return name;
  return { 网页浏览: 'Web browsing', 我的手记: 'My notes', 杂项: 'Misc' }[name] ?? name;
}

export const hhmm = (ts) => {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '--:--' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const WEEK = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const WEEK_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 2026-09-09 → 「9月9日 星期三」/「Wed, Sep 9」；不是今年再带上年份。 */
export function dateWords(iso) {
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  if (en()) return `${WEEK_EN[d.getDay()]}, ${MONTH_EN[d.getMonth()]} ${d.getDate()}${sameYear ? '' : `, ${d.getFullYear()}`}`;
  const y = sameYear ? '' : `${d.getFullYear()}年`;
  return `${y}${d.getMonth() + 1}月${d.getDate()}日 ${WEEK[d.getDay()]}`;
}

/** 相对今天的称呼：今天 / 昨天 / 前天 / 空。 */
export function relativeDay(iso, today) {
  if (!today) return '';
  const a = new Date(`${iso}T12:00:00`);
  const b = new Date(`${today}T12:00:00`);
  const diff = Math.round((b - a) / 86_400_000);
  const key = { 0: 'today', 1: 'yesterday', 2: 'dayBefore', '-1': 'tomorrow' }[diff];
  return key ? t(key) : '';
}

export function shiftIso(iso, days) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function timeRange(m) {
  return m.durationMin ? `${hhmm(m.startTs)}–${hhmm(m.endTs)}` : hhmm(m.startTs);
}

export function durationWords(min) {
  if (!min) return '';
  const h = Math.floor(min / 60);
  const r = min % 60;
  if (en()) return h && r ? `${h} h ${r} min` : h ? `${h} h` : `${r} min`;
  if (h && r) return `${h} 小时 ${r} 分钟`;
  if (h) return `${h} 小时`;
  return `${r} 分钟`;
}

/** 「5 提问、2 文件」—— 只列非零项。 */
export function statsWords(stats, { short = false } = {}) {
  const s = stats || {};
  const b = [];
  const E = en();
  if (s.commits) b.push(E ? `${s.commits} commit${s.commits > 1 ? 's' : ''}` : `${s.commits} 提交`);
  if (s.clones) b.push(E ? `${s.clones} clone${s.clones > 1 ? 's' : ''}` : `clone ${s.clones} 个仓库`);
  if (s.prompts) b.push(E ? `${s.prompts} ask${s.prompts > 1 ? 's' : ''}` : `${s.prompts} 提问`);
  if (s.commands && !short) b.push(E ? `${s.commands} cmd${s.commands > 1 ? 's' : ''}` : `${s.commands} 命令`);
  if (s.shell) b.push(E ? `${s.shell} shell` : `${s.shell} 终端命令`);
  if (s.searches && !short) b.push(E ? `${s.searches} search${s.searches > 1 ? 'es' : ''}` : `${s.searches} 搜索`);
  if (s.files) b.push(E ? `${s.files} file${s.files > 1 ? 's' : ''}` : `${s.files} 文件`);
  if (s.pages) b.push(E ? `${s.pages} page${s.pages > 1 ? 's' : ''}` : `${s.pages} 页面`);
  if (s.notes) b.push(E ? 'notes' : '手记');
  if (s.images) b.push(E ? `${s.images} image${s.images > 1 ? 's' : ''}` : `${s.images} 张图`);
  return b.join(E ? ', ' : '、');
}

/** 秒 → 「约 12 分钟」；不到一分钟不值得写。 */
export function stayWords(secs) {
  const s = Number(secs) || 0;
  if (s < 60) return '';
  if (s < 3600) return en() ? `~${Math.round(s / 60)} min` : `约 ${Math.round(s / 60)} 分钟`;
  const h = (s / 3600).toFixed(1).replace(/\.0$/, '');
  return en() ? `~${h} h` : `约 ${h} 小时`;
}

/** 首屏那一句：今天从 08:09 到 16:23 留下了 9 段痕迹，8 段写进日记。 */
export function daySentence(modules, iso, today) {
  const rel = relativeDay(iso, today);
  const when = rel || dateWords(iso);
  const E = en();
  if (!modules.length) return E ? `No traces ${rel ? rel : `on ${when}`}.` : `${when}没有留下痕迹。`;
  const starts = modules.map((m) => m.startTs).sort();
  const ends = modules.map((m) => m.endTs || m.startTs).sort();
  const on = modules.filter((m) => m.selected).length;
  const a = hhmm(starts[0]);
  const b = hhmm(ends[ends.length - 1]);
  if (E) {
    const W = rel ? rel.charAt(0).toUpperCase() + rel.slice(1) : when;
    const tail = on === modules.length ? 'all going into the diary.' : on === 0 ? 'none in the diary yet.' : `${on} going into the diary.`;
    return `${W}, from ${a} to ${b}, left ${modules.length} trace${modules.length > 1 ? 's' : ''}, ${tail}`;
  }
  const span = `从 ${a} 到 ${b}`;
  const n = `${modules.length} 段痕迹`;
  let tail;
  if (on === modules.length) tail = '全部写进日记。';
  else if (on === 0) tail = '还没有一段写进日记。';
  else tail = `${on} 段写进日记。`;
  return `${when}${span} 留下了 ${n}，${tail}`;
}

/** 第二句：看过什么、没找到什么。 */
export function sourcesSentence(sources) {
  if (!sources) return '';
  const E = en();
  const seen = [];
  const missing = [];
  if (sources.repos) seen.push(E ? `${sources.repos} git repo${sources.repos > 1 ? 's' : ''}` : `${sources.repos} 个 git 仓库`);
  if (sources.fileScan) seen.push(E ? `${sources.files} files in ${sources.fileScan.dirs} folders` : `${sources.fileScan.dirs} 个目录里的 ${sources.files} 个文件`);
  // 没装的工具不提：「没有读到 Codex、Cursor、Cline…」是一串没有信息量的名字
  for (const r of sources.sessions ?? []) {
    if (r.status === 'ok' && r.count > 0) seen.push(E ? `${r.count} ${r.name} session${r.count > 1 ? 's' : ''}${r.generic ? ' (generic format)' : ''}` : `${r.name} ${r.count} 个会话${r.generic ? '（通用格式）' : ''}`);
    else if (r.status !== 'ok' && r.status !== 'absent') missing.push(E ? `${r.name} (${r.error || 'parse failed'})` : `${r.name}（${r.error || '解析失败'}）`);
  }
  if (sources.shell) {
    if (sources.shell.exists) seen.push(E ? `${sources.shell.commands} shell commands` : `终端 ${sources.shell.commands} 条命令`);
    else missing.push(E ? 'shell commands (hook has not logged anything yet)' : '终端命令（钩子还没记到东西）');
  }
  if (sources.browser) {
    const ok = sources.browser.report.filter((r) => r.status === 'ok');
    const denied = sources.browser.report.filter((r) => r.status !== 'ok');
    const names = [...new Set(ok.map((r) => r.name))].join(E ? ', ' : '、');
    if (ok.length) seen.push(E ? `${sources.browser.visits} ${names} visits` : `${names} ${sources.browser.visits} 次访问`);
    for (const d of denied) missing.push(E ? `${d.name} (${d.status === 'denied' ? 'no read permission' : d.error || d.status})` : `${d.name}（${d.status === 'denied' ? '没有读取权限' : d.error || d.status}）`);
  }
  if (E) {
    const a = seen.length ? `Looked at ${seen.join(', ')}` : '';
    const b = missing.length ? `could not read ${missing.join(', ')}` : '';
    return [a, b].filter(Boolean).join('; ') + (a || b ? '.' : '');
  }
  const a = seen.length ? `看过 ${seen.join('、')}` : '';
  const b = missing.length ? `没有读到 ${missing.join('、')}` : '';
  return [a, b].filter(Boolean).join('；') + (a || b ? '。' : '');
}

/** 稳定哈希：同一个模块每次都是同一个形状。 */
export function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 墨迹形状：八个圆角半径各自偏一点，圆就成了一滴痕迹。偏得不多，仍然一眼是「泡泡」。 */
export function blobRadius(key) {
  const h = hash(key);
  const v = (i) => 50 + (((h >>> (i * 4)) & 15) - 7.5) * 1.6; // 38 ～ 62
  return `${v(0)}% ${100 - v(0)}% ${v(1)}% ${100 - v(1)}% / ${v(2)}% ${v(3)}% ${100 - v(3)}% ${100 - v(2)}%`;
}

export function catVar(cat) {
  return CAT_VAR[cat] ?? 'other';
}

export function cut(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** 数字格式：969 → 969，12345 → 1.2 万 */
export function num(n) {
  const v = Number(n) || 0;
  return v >= 10_000 ? `${(v / 10_000).toFixed(1)} 万` : String(v);
}

/** 泡泡上的工具名：「Codex」「Claude Code」；用了好几个就写最多的那个加「等」。 */
export function toolWords(m) {
  const names = m?.toolNames ?? [];
  if (!names.length) return '';
  return names.length > 1 ? (en() ? `${names[0]} +` : `${names[0]} 等`) : names[0];
}

/** 泡泡上放不下整个标题：浏览段只写搜索词或站点，其余用标题本身。 */
export function blobTitle(m) {
  // 「改动 4 个文件：nodejs/（.ps1）」放不下，留「改动 4 个文件（.ps1）」：扩展名比目录名更能说明改的是什么
  const files = String(m.title ?? '').match(/^改动 (\d+) 个文件(?:：[^（]*)?(（[^）]+）)?/);
  if (files) return en() ? `${files[1]} files edited${files[2] ? ` ${files[2].replace('（', '(').replace('）', ')')}` : ''}` : `改动 ${files[1]} 个文件${files[2] ?? ''}`;
  if (m.burst) return en() ? `New project (${m.stats?.files ?? ''} files)` : `新增项目（${m.stats?.files ?? ''} 个文件）`;
  if (m.category !== '网页') return m.title;
  const items = m.items ?? [];
  const term = items.find((i) => i.term)?.term;
  if (term) return en() ? `Search "${term}"` : `搜索「${term}」`;
  const hosts = new Map();
  for (const i of items) if (i.host) hosts.set(i.host, (hosts.get(i.host) ?? 0) + 1);
  const top = [...hosts.entries()].sort((a, b) => b[1] - a[1]).map(([h]) => h);
  if (!top.length) return m.title;
  // 域名只允许在点后面换行，别把 fluxionai.space 拆成 fluxionai.sp / ace
  const host = top[0].replace(/\./g, '.\u200b');
  return top.length > 1 ? (en() ? `${host} +${top.length - 1}` : `${host} 等 ${top.length} 站`) : host;
}
