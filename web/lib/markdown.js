/** 离线 Markdown 子集：HTML 始终作为文本；不加载图片或执行链接协议。 */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function safeLink(url) {
  if (/[\u0000-\u0020\u007f]/.test(url)) return false;
  return /^https?:\/\//i.test(url) || /^mailto:/i.test(url) || /^#[\w-]+$/.test(url);
}

export function markdownToHtml(md, language = 'zh') {
  const lines = String(md ?? '').replace(/\r\n?/g, '\n').split('\n');
  const fns = Object.create(null);
  let fence = null;
  const body = lines.filter((line) => {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      return true;
    }
    const fn = !fence && line.match(/^\[\^(ev\d+)\]:\s*(.*)$/);
    if (fn) { fns[fn[1]] = fn[2]; return false; }
    return true;
  });
  function inline(text, level = 0) {
    if (level > 6) return esc(text);
    const tokens = /(`+)([^`]*?)\1|!\[([^\]]*)\]\(([^\s)]*)\)|\[([^\]]+)\]\(([^\s)]*)\)|\[\^(ev\d+)\]|\*\*([^*]+)\*\*|~~([^~]+)~~|\*([^*\n]+)\*/g;
    let out = '', from = 0;
    for (const m of text.matchAll(tokens)) {
      out += esc(text.slice(from, m.index));
      if (m[1]) out += /^(inferred|unverified)$/.test(m[2]) ? `<span class="conf ${m[2]}">${m[2]}</span>` : `<code>${esc(m[2])}</code>`;
      else if (m[3] !== undefined) out += `<span class="md-image-note">[${language === 'en' ? 'Image' : '图片'}: ${esc(m[3])}]</span>`;
      else if (m[5] !== undefined) out += safeLink(m[6]) ? `<a href="${esc(m[6])}" target="_blank" rel="noopener noreferrer">${inline(m[5], level + 1)}</a>` : esc(m[0]);
      else if (m[7]) out += `<sup class="fn" title="${esc(fns[m[7]] ?? '')}"><a href="#${m[7]}">${m[7].slice(2)}</a></sup>`;
      else if (m[8]) out += `<strong>${inline(m[8], level + 1)}</strong>`;
      else if (m[9]) out += `<del>${inline(m[9], level + 1)}</del>`;
      else out += `<em>${inline(m[10], level + 1)}</em>`;
      from = m.index + m[0].length;
    }
    return out + esc(text.slice(from));
  }
  const out = [], stack = [];
  function closeList() { const l = stack.pop(); out.push(`</li></${l.type}>`); }
  function flush() { while (stack.length) closeList(); }
  const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((s) => s.trim());
  for (let i = 0; i < body.length; i++) {
    const line = body[i];
    let m;
    if ((m = line.match(/^\s{0,3}(`{3,}|~{3,})([^`]*)$/))) {
      flush();
      const code = [], marker = m[1];
      while (++i < body.length) {
        const end = body[i].match(/^\s{0,3}(`{3,}|~{3,})\s*$/);
        if (end && end[1][0] === marker[0] && end[1].length >= marker.length) break;
        code.push(body[i]);
      }
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
    } else if (line.includes('|') && body[i + 1]?.includes('|') && cells(body[i + 1]).every((c) => /^:?-{3,}:?$/.test(c))) {
      flush();
      const headers = cells(line);
      out.push(`<div class="md-table"><table><thead><tr>${headers.map((s) => `<th>${inline(s)}</th>`).join('')}</tr></thead><tbody>`);
      i++;
      while (body[i + 1]?.trim() && body[i + 1].includes('|')) {
        const row = cells(body[++i]);
        out.push(`<tr>${headers.map((_, n) => `<td>${inline(row[n] ?? '')}</td>`).join('')}</tr>`);
      }
      out.push('</tbody></table></div>');
    } else if ((m = line.match(/^(#{1,6})\s+(.+)$/))) {
      flush(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
    } else if ((m = line.match(/^(\s*)([-+*]|\d+[.)])\s+(.+)$/))) {
      const indent = m[1].replace(/\t/g, '    ').length;
      const type = /^\d/.test(m[2]) ? 'ol' : 'ul';
      while (stack.length && indent < stack.at(-1).indent) closeList();
      if (stack.length && indent === stack.at(-1).indent && type !== stack.at(-1).type) closeList();
      if (!stack.length || indent > stack.at(-1).indent) {
        out.push(`<${type}><li>`); stack.push({ type, indent });
      } else out.push('</li><li>');
      const task = m[3].match(/^\[([ xX])\]\s+(.*)$/);
      out.push(task ? `<span class="md-task"><input type="checkbox" disabled ${task[1] !== ' ' ? 'checked' : ''} aria-label="${task[1] !== ' ' ? 'Done' : 'To do'}"> ${inline(task[2])}</span>` : inline(m[3]));
    } else {
      flush();
      if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) out.push('<hr>');
      else if ((m = line.match(/^>\s?(.*)$/))) out.push(`<blockquote>${inline(m[1])}</blockquote>`);
      else if ((m = line.match(/^_(.+)_$/))) out.push(`<p class="meta">${inline(m[1])}</p>`);
      else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
    }
  }
  flush();
  const ids = Object.keys(fns).sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
  if (ids.length) out.push(`<details class="fns"><summary>${language === 'en' ? `${ids.length} pieces of evidence` : `证据 ${ids.length} 条`}</summary><ol>${ids.map((id) => `<li id="${id}">${inline(fns[id])}</li>`).join('')}</ol></details>`);
  return out.join('\n');
}
