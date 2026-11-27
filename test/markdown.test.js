import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownToHtml } from '../web/lib/markdown.js';
import { formatSelection } from '../web/lib/editor.js';

test('编辑器 Markdown 支持标题、代码、任务、表格、引用与常用行内格式', () => {
  const html = markdownToHtml('# 标题\n\n**粗体** *斜体* ~~删除~~ `x_y`\n\n- [x] 完成\n- [ ] 待办\n\n> 引用\n\n```js\nconst a = "<tag>";\n```\n\n| A | B |\n| --- | --- |\n| 一 | 二 |');
  for (const fragment of ['<h1>标题</h1>', '<strong>粗体</strong>', '<em>斜体</em>', '<del>删除</del>', '<code>x_y</code>', 'checked', '<blockquote>引用</blockquote>', '<pre><code>const a = &quot;&lt;tag&gt;&quot;;', '<td>二</td>']) assert.ok(html.includes(fragment), fragment);
});
test('危险 HTML、链接和远程图片不执行或自动加载', () => {
  const html = markdownToHtml('<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n[x](javascript:alert) [y](data:text/html) ![跟踪](https://tracker.example/pixel) [z](https://example.com/?x="onclick="evil)');
  assert.ok(!/<script|<img|href="javascript:|href="data:/.test(html));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /&quot;onclick=&quot;/);
});
test('证据脚注兼容，代码块和行内代码中的 Markdown 保持为文本', () => {
  const html = markdownToHtml('事实[^ev1]\n\n[^ev1]: 原始证据 <img>\n\n```\n[^ev2]: 不应折叠\n```\n\n`**不是粗体**`\n\n_ERP_code 与 AI_log_');
  assert.match(html, /证据 1 条/);
  assert.match(html, /id="ev1"/);
  assert.match(html, /<pre><code>\[\^ev2\]: 不应折叠/);
  assert.match(html, /<code>\*\*不是粗体\*\*<\/code>/);
  assert.match(html, /ERP_code 与 AI_log/);
});
test('嵌套列表位于父 li 内，有序列表正常闭合', () => {
  const html = markdownToHtml('- 父项\n  - 子项\n- 第二项\n\n1. 编号');
  assert.match(html, /<ul><li>\n父项\n<ul><li>\n子项\n<\/li><\/ul>\n<\/li><li>/);
  assert.match(html, /<ol><li>\n编号\n<\/li><\/ol>/);
});
test('格式工具只修改选区或选中行，保留其余正文', () => {
  assert.deepEqual(formatSelection('abc def', 0, 3, 'bold'), { text: '**abc** def', start: 2, end: 5 });
  const task = formatSelection('before\nfirst\nsecond\nafter', 8, 18, 'task');
  assert.equal(task.text, 'before\n- [ ] first\n- [ ] second\nafter');
});
