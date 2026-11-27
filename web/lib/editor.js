export function formatSelection(text, start, end, action) {
  const selected = text.slice(start, end);
  const wraps = { bold: ['**', '**'], italic: ['*', '*'], strike: ['~~', '~~'], code: ['`', '`'], link: ['[', '](https://example.com)'] };
  let insert, selectStart = start, selectEnd;
  if (wraps[action]) {
    const [left, right] = wraps[action];
    const body = selected || (action === 'link' ? '链接文字' : '文字');
    insert = left + body + right;
    selectStart += left.length; selectEnd = selectStart + body.length;
  } else if (action === 'block' || action === 'table') {
    insert = action === 'block' ? '\n```\n' + (selected || 'code') + '\n```\n' : '\n| 项目 | 内容 |\n| --- | --- |\n| 记录 | 说明 |\n';
    selectEnd = start + insert.length;
  } else {
    const prefixes = { heading: '## ', list: '- ', ordered: '1. ', task: '- [ ] ', quote: '> ' };
    start = text.lastIndexOf('\n', start - 1) + 1;
    const tail = text.indexOf('\n', end);
    end = tail < 0 ? text.length : tail;
    insert = text.slice(start, end).split('\n').map((line) => (prefixes[action] ?? '') + line).join('\n');
    selectStart = start; selectEnd = start + insert.length;
  }
  return { text: text.slice(0, start) + insert + text.slice(end), start: selectStart, end: selectEnd };
}
