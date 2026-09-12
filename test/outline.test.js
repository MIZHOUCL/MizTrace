import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { openZip } from '../src/collect/zip.js';
import { readOutline, decodeText, decodeXml, pdfTitle, outlineText, supportsOutline } from '../src/collect/outline.js';

/** 测试用的最小 zip 写入器：本地头 + 中央目录 + EOCD，deflate 或 store。 */
export function makeZip(entries, { store = false } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, body] of Object.entries(entries)) {
    const raw = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    const data = store ? raw : zlib.deflateRawSync(raw);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(store ? 0 : 8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

function tmpFile(name, buf) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miztrace-outline-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, buf);
  return p;
}

const P = (text, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

test('zip 读取器：能读 deflate 与 store 条目，不是 zip 就报错', () => {
  const buf = makeZip({ 'a.txt': 'hello', 'dir/b.xml': '<x>中文 &amp; 符号</x>' });
  const z = openZip(buf);
  assert.deepEqual(z.names, ['a.txt', 'dir/b.xml']);
  assert.equal(z.read('a.txt').toString(), 'hello');
  assert.equal(z.read('dir/b.xml').toString(), '<x>中文 &amp; 符号</x>');
  assert.equal(z.read('missing'), null);
  assert.equal(openZip(makeZip({ 's.txt': 'raw' }, { store: true })).read('s.txt').toString(), 'raw');
  assert.throws(() => openZip(Buffer.from('not a zip at all, definitely not')), /zip/);
});

test('docx：按样式名 / 样式 id / outlineLvl 认标题，中文 Word 的样式 id 是数字', () => {
  const styles = `<w:styles><w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="a"><w:name w:val="Normal"/></w:style></w:styles>`;
  const doc = `<w:document><w:body>${P('本周进展', '1')}${P('正文一大段，不该出现在大纲里', 'a')}${P('风险', 'Heading2')}<w:p><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:r><w:t>下周计划</w:t></w:r></w:p>${P('附录 &amp; 备注', 'Title')}</w:body></w:document>`;
  const file = tmpFile('周报.docx', makeZip({ 'word/document.xml': doc, 'word/styles.xml': styles }));
  const o = readOutline(file);
  assert.deepEqual(o, { kind: 'headings', items: ['本周进展', '风险', '下周计划', '附录 & 备注'] });
  assert.equal(outlineText(o), '标题：本周进展 ／ 风险 ／ 下周计划 ／ 附录 & 备注');
});

test('docx：没有标题样式的文档退回首段（很多人不用样式，标题只是加粗）', () => {
  const doc = `<w:document><w:body>${P('')}${P('铭利达 SRM 接口方案')}${P('第二段正文')}</w:body></w:document>`;
  const file = tmpFile('方案.docx', makeZip({ 'word/document.xml': doc }));
  assert.deepEqual(readOutline(file), { kind: 'title', items: ['铭利达 SRM 接口方案'] });
});

test('xlsx 工作表名与 pptx 每页标题（按页码排序，实体解码）', () => {
  const wb = `<workbook><sheets><sheet name="出勤 &amp; 考核" sheetId="1" r:id="rId1"/><sheet r:id="rId2" sheetId="2" name="Sheet2"/></sheets></workbook>`;
  assert.deepEqual(readOutline(tmpFile('x.xlsx', makeZip({ 'xl/workbook.xml': wb }))), { kind: 'sheets', items: ['出勤 & 考核', 'Sheet2'] });

  const slide = (title, type = 'title') =>
    `<p:sld><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="${type}"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>正文不要</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  const pptx = makeZip({ 'ppt/slides/slide10.xml': slide('第十页'), 'ppt/slides/slide1.xml': slide('封面', 'ctrTitle'), 'ppt/slides/slide2.xml': slide('目录') });
  assert.deepEqual(readOutline(tmpFile('d.pptx', pptx)), { kind: 'slides', items: ['封面', '目录', '第十页'] });
  const noTitle = makeZip({ 'ppt/slides/slide1.xml': '<p:sld></p:sld>', 'ppt/slides/slide2.xml': '<p:sld></p:sld>' });
  assert.deepEqual(readOutline(tmpFile('e.pptx', noTitle)), { kind: 'slides', items: ['2 页'] });
});

test('文本类：md 标题、无标题退回首行、csv 表头、sql 语句、ipynb', () => {
  assert.deepEqual(readOutline(tmpFile('a.md', '# 周报\n\n正文\n\n## 进展 ##\n### 风险\n#### 太深不要\n')), { kind: 'headings', items: ['周报', '进展', '风险'] });
  assert.deepEqual(readOutline(tmpFile('b.md', '\n\n---\n第一行才是标题\n第二行\n')), { kind: 'title', items: ['第一行才是标题'] });
  assert.deepEqual(readOutline(tmpFile('c.txt', '\r\n会议纪要 9.9\r\n内容')), { kind: 'title', items: ['会议纪要 9.9'] });
  assert.deepEqual(readOutline(tmpFile('d.csv', '"姓名",部门,入职日期,,\n张三,IT,2020')), { kind: 'columns', items: ['姓名', '部门', '入职日期'] });
  assert.deepEqual(readOutline(tmpFile('e.sql', '-- 采购订单行关闭同步\nCREATE TABLE IF NOT EXISTS t_close_log (\n id int\n);\nselect * from x;')), { kind: 'statements', items: ['采购订单行关闭同步', 'CREATE TABLE IF NOT EXISTS t_close_log'] });
  assert.deepEqual(readOutline(tmpFile('f.sql', 'select a from b where c = 1')), { kind: 'statements', items: ['select a from b where c = 1'] });
  const nb = JSON.stringify({ cells: [{ cell_type: 'code', source: ['# 不是标题\n'] }, { cell_type: 'markdown', source: ['# 数据清洗\n', '文字\n', '## 去重\n'] }] });
  assert.deepEqual(readOutline(tmpFile('g.ipynb', nb)), { kind: 'headings', items: ['数据清洗', '去重'] });
});

test('pdf：只认元数据标题（字面量 / UTF-16 十六进制 / XMP），没有就放弃', () => {
  assert.equal(pdfTitle(Buffer.from('%PDF-1.4\n1 0 obj << /Title (Hello \\(World\\)) /Author (x) >>', 'latin1')), 'Hello (World)');
  const hex = Buffer.from('feff' + Buffer.from('简历', 'utf16le').swap16().toString('hex'), 'hex').toString('hex');
  assert.equal(pdfTitle(Buffer.from(`%PDF-1.7\n<< /Title <${hex}> >>`, 'latin1')), '简历');
  const utf16Literal = Buffer.concat([Buffer.from('%PDF /Title (', 'latin1'), Buffer.from([0xfe, 0xff, 0x7b, 0x80, 0x53, 0x86]), Buffer.from(')', 'latin1')]);
  assert.equal(pdfTitle(utf16Literal), '简历');
  assert.equal(pdfTitle(Buffer.from('<x:xmpmeta><dc:title><rdf:Alt><rdf:li xml:lang="x-default">XMP 标题 &amp; 更多</rdf:li></rdf:Alt></dc:title></x:xmpmeta>')), 'XMP 标题 & 更多');
  assert.equal(pdfTitle(Buffer.from('%PDF-1.4 no metadata here')), null);
  assert.equal(readOutline(tmpFile('h.pdf', Buffer.from('%PDF-1.4\n<< /Title (报价单) >>', 'utf8'))).items[0], '报价单', 'UTF-8 字面量（不合规但常见）');
  assert.equal(readOutline(tmpFile('i.pdf', Buffer.from('%PDF-1.4 nothing'))), null);
});

test('编码与边界：GB18030 的 txt 能解、不支持的扩展名与不存在的文件返回 null、坏 zip 不抛', () => {
  assert.equal(decodeText(Buffer.from([0xd6, 0xd0, 0xce, 0xc4])), '中文', 'Windows 上的 GBK 文本');
  assert.equal(decodeText(Buffer.from('utf8 文本')), 'utf8 文本');
  assert.equal(decodeXml('a &lt;b&gt; &#20013;&#x6587; &quot;'), 'a <b> 中文 "');
  assert.equal(supportsOutline('x.docx'), true);
  assert.equal(supportsOutline('x.js'), false);
  assert.equal(readOutline(tmpFile('code.js', '# not md')), null);
  assert.equal(readOutline('/definitely/missing/file.md'), null);
  assert.equal(readOutline(tmpFile('bad.docx', Buffer.from('this is not a zip archive at all'))), null);
  assert.equal(outlineText(null), '');
  assert.equal(outlineText({ kind: 'sheets', items: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }), '工作表：a ／ b ／ c ／ d ／ e 等 7 项');
});
