/** 极简 Markdown → HTML：只认标题、列表、引用、粗体、行内代码、脚注。输入先全量转义。 */
import { lang } from './i18n.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function renderMd(md) {
  const lines = String(md ?? '').split('\n');
  const fns = {};
  const body = [];
  for (const l of lines) {
    const m = l.match(/^\[\^(ev\d+)\]:\s*(.*)$/);
    if (m) fns[m[1]] = m[2];
    else body.push(l);
  }
  const inline = (t) =>
    esc(t)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, (_, c) => (/^(inferred|unverified)$/.test(c) ? `<span class="conf ${c}">${c}</span>` : `<code>${c}</code>`))
      .replace(/\[\^(ev\d+)\]/g, (_, id) => `<sup class="fn" title="${esc(fns[id] ?? '')}"><a href="#${id}">${id.slice(2)}</a></sup>`);
  // 斜体只认「整行被 _ 包住」（日记里的模块 meta 行就是这种）。不能在行内匹配 _..._：
  // 项目名 ERP_code、AI_log 里的下划线会被当成斜体标记，把 meta 行渲染得支离破碎。
  const out = [];
  let list = null;
  let depth = 0;
  const flush = () => {
    while (depth > 0) {
      out.push('</ul>');
      depth -= 1;
    }
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (const l of body) {
    if (/^---\s*$/.test(l)) {
      flush();
      continue;
    }
    let m;
    if ((m = l.match(/^(#{1,3})\s+(.*)$/))) {
      flush();
      out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
    } else if ((m = l.match(/^(\s*)[-*]\s+(.*)$/))) {
      const want = Math.min(2, Math.floor(m[1].length / 2));
      if (list !== 'ul') {
        flush();
        list = 'ul';
        out.push('<ul>');
      }
      while (depth < want) {
        out.push('<ul class="sub">');
        depth += 1;
      }
      while (depth > want) {
        out.push('</ul>');
        depth -= 1;
      }
      out.push(`<li>${inline(m[2])}</li>`);
    } else if ((m = l.match(/^\s*\d+\.\s+(.*)$/))) {
      if (list !== 'ol') {
        flush();
        list = 'ol';
        out.push('<ol>');
      }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = l.match(/^>\s?(.*)$/))) {
      flush();
      out.push(`<blockquote>${inline(m[1])}</blockquote>`);
    } else if ((m = l.match(/^_(.+)_$/))) {
      flush();
      out.push(`<p class="meta">${inline(m[1])}</p>`);
    } else if (l.trim()) {
      flush();
      out.push(`<p>${inline(l)}</p>`);
    } else flush();
  }
  flush();
  // 脚注默认折叠：二十几条证据原文比正文还长，摊开就成了流水账。上标悬停能看原文，点上标会展开并跳过去。
  const ids = Object.keys(fns).sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
  if (ids.length) out.push(`<details class="fns"><summary>${lang.value === 'en' ? `${ids.length} pieces of evidence` : `证据 ${ids.length} 条`}</summary><ol>${ids.map((id) => `<li id="${id}">${inline(fns[id])}</li>`).join('')}</ol></details>`);
  return out.join('\n');
}
