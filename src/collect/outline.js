/**
 * 文档大纲（ADR-022，读取级别 L1）：只取**结构**，不取正文。
 *
 *   docx  → 标题层级（按样式名 heading/标题/Title 或 outlineLvl 判定）；没有标题样式时退回首段（很多人不用样式）
 *   xlsx  → 工作表名
 *   pptx  → 每页的标题占位符
 *   md    → # 标题；没有标题时退回首行
 *   txt   → 首行
 *   csv   → 表头列名
 *   sql   → 首条注释或首条语句
 *   pdf   → 元数据里的 Title（Info 字典或 XMP），没有就放弃
 *   ipynb → 首个 markdown 单元的标题
 *
 * 任何一步失败都返回 null，绝不中断采集。文件太大直接跳过。
 */
import fs from 'node:fs';
import path from 'node:path';
import { openZip } from './zip.js';

export const OUTLINE_EXTENSIONS = new Set(['docx', 'xlsx', 'pptx', 'md', 'markdown', 'txt', 'csv', 'tsv', 'sql', 'pdf', 'ipynb', 'rst', 'adoc']);
const MAX_ZIP_BYTES = 40 * 1024 * 1024;
const MAX_TEXT_BYTES = 512 * 1024;
const MAX_ITEMS = 10;
const MAX_ITEM_CHARS = 60;

export function supportsOutline(filePath) {
  return OUTLINE_EXTENSIONS.has(extOf(filePath));
}

function extOf(p) {
  const name = path.basename(String(p));
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

export function decodeXml(s) {
  return String(s ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function tidy(s) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > MAX_ITEM_CHARS ? `${t.slice(0, MAX_ITEM_CHARS)}…` : t;
}

function finish(kind, items) {
  const clean = [];
  for (const it of items) {
    const t = tidy(it);
    if (t && !clean.includes(t)) clean.push(t);
    if (clean.length >= MAX_ITEMS) break;
  }
  return clean.length ? { kind, items: clean } : null;
}

/** 文本文件解码：先按 UTF-8 严格解，失败再按 GB18030（Windows 上的中文 txt / csv / sql 常见）。 */
export function decodeText(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('gb18030').decode(buf);
    } catch {
      return buf.toString('latin1');
    }
  }
}

function readHead(filePath, max = MAX_TEXT_BYTES) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const n = Math.min(size, max);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, 0);
    return { buf, size };
  } finally {
    fs.closeSync(fd);
  }
}

// ---------- 各格式 ----------

function markdownOutline(text) {
  const heads = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s{0,3}#{1,3}\s+(.+?)\s*#*\s*$/);
    if (m) heads.push(m[1].replace(/[*_`]/g, ''));
    if (heads.length >= MAX_ITEMS) break;
  }
  if (heads.length) return finish('headings', heads);
  return firstLineOutline(text);
}

function firstLineOutline(text) {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l && !/^[-=*#>|`~]+$/.test(l));
  return line ? finish('title', [line.replace(/^#+\s*/, '')]) : null;
}

function csvOutline(text, sep) {
  const first = text.split('\n')[0] ?? '';
  const cols = first
    .split(sep)
    .map((c) => c.replace(/^"|"$/g, '').trim())
    .filter(Boolean)
    .slice(0, 8);
  return cols.length ? finish('columns', cols) : null;
}

function sqlOutline(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const out = [];
  const comment = lines.find((l) => l.startsWith('--') || l.startsWith('/*'));
  if (comment) out.push(comment.replace(/^--\s*|^\/\*\s*|\s*\*\/$/g, ''));
  const stmts = text.match(/\b(?:create|alter|drop)\s+(?:or\s+replace\s+)?(?:table|view|procedure|function|index|trigger)\s+(?:if\s+(?:not\s+)?exists\s+)?[`"[\]\w.]+/gi) ?? [];
  for (const s of stmts) out.push(s.replace(/\s+/g, ' '));
  if (!out.length) {
    const first = lines.find((l) => !l.startsWith('--') && !l.startsWith('/*'));
    if (first) out.push(first);
  }
  return finish('statements', out);
}

function docxOutline(zip) {
  const doc = zip.read('word/document.xml')?.toString('utf8');
  if (!doc) return null;
  const styles = zip.read('word/styles.xml')?.toString('utf8') ?? '';
  const headingIds = new Set();
  for (const m of styles.matchAll(/<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g)) {
    const name = m[2].match(/<w:name\b[^>]*w:val="([^"]*)"/)?.[1] ?? '';
    if (/^(heading\s?\d|title|标题\s?\d?|subtitle)$/i.test(decodeXml(name))) headingIds.add(m[1]);
  }
  const heads = [];
  const paras = [];
  for (const pm of doc.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)) {
    const p = pm[0];
    const text = decodeXml([...p.matchAll(/<w:t\b[^>]*>([^<]*)<\/w:t>/g)].map((x) => x[1]).join('')).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const style = p.match(/<w:pStyle\b[^>]*w:val="([^"]+)"/)?.[1];
    const lvl = p.match(/<w:outlineLvl\b[^>]*w:val="(\d)"/)?.[1];
    const isHeading = (style && (headingIds.has(style) || /^(heading\d|\d|title)$/i.test(style))) || (lvl !== undefined && Number(lvl) <= 2);
    if (isHeading) {
      heads.push(text);
      if (heads.length >= MAX_ITEMS) break;
    } else if (paras.length < 1) paras.push(text);
    if (heads.length === 0 && paras.length >= 1 && pm.index > 400_000) break; // 没有标题样式的大文档不必读完
  }
  if (heads.length) return finish('headings', heads);
  return paras.length ? finish('title', paras) : null;
}

function xlsxOutline(zip) {
  const wb = zip.read('xl/workbook.xml')?.toString('utf8');
  if (!wb) return null;
  const names = [...wb.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((m) => decodeXml(m[1]));
  return names.length ? finish('sheets', names) : null;
}

function pptxOutline(zip) {
  const slides = zip.names
    .map((n) => ({ n, no: Number(n.match(/^ppt\/slides\/slide(\d+)\.xml$/)?.[1]) }))
    .filter((s) => Number.isFinite(s.no))
    .sort((a, b) => a.no - b.no);
  if (!slides.length) return null;
  const titles = [];
  for (const s of slides.slice(0, 40)) {
    const xml = zip.read(s.n)?.toString('utf8');
    if (!xml) continue;
    for (const sp of xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)) {
      if (!/<p:ph\b[^>]*type="(?:title|ctrTitle)"/.test(sp[0])) continue;
      const text = decodeXml([...sp[0].matchAll(/<a:t\b[^>]*>([^<]*)<\/a:t>/g)].map((x) => x[1]).join('')).trim();
      if (text) titles.push(text);
      break;
    }
    if (titles.length >= MAX_ITEMS) break;
  }
  if (titles.length) return finish('slides', titles);
  return finish('slides', [`${slides.length} 页`]);
}

/** PDF 只认元数据标题：Info 字典的 /Title 或 XMP 的 dc:title。 */
export function pdfTitle(buf) {
  const latin = buf.toString('latin1');
  const decodePdfString = (s) => {
    const bytes = [];
    for (let i = 0; i < s.length; i += 1) {
      const ch = s[i];
      if (ch !== '\\') {
        bytes.push(s.charCodeAt(i) & 0xff);
        continue;
      }
      const nx = s[i + 1];
      if (/[0-7]/.test(nx ?? '')) {
        const oct = s.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)[0];
        bytes.push(parseInt(oct, 8) & 0xff);
        i += oct.length;
      } else {
        bytes.push({ n: 10, r: 13, t: 9, b: 8, f: 12 }[nx] ?? s.charCodeAt(i + 1));
        i += 1;
      }
    }
    const b = Buffer.from(bytes);
    if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return utf16be(b.subarray(2));
    return decodeText(b);
  };
  let m = latin.match(/\/Title\s*\(((?:\\.|[^\\)])*)\)/);
  if (m) {
    const t = decodePdfString(m[1]).trim();
    if (t) return t;
  }
  m = latin.match(/\/Title\s*<([0-9A-Fa-f\s]+)>/);
  if (m) {
    const b = Buffer.from(m[1].replace(/\s+/g, ''), 'hex');
    const t = (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff ? utf16be(b.subarray(2)) : decodeText(b)).trim();
    if (t) return t;
  }
  const xmp = buf.toString('utf8').match(/<dc:title>[\s\S]*?<rdf:li[^>]*>([^<]+)<\/rdf:li>/);
  if (xmp) return decodeXml(xmp[1]).trim() || null;
  return null;
}

function utf16be(b) {
  const swapped = Buffer.alloc(b.length - (b.length % 2));
  for (let i = 0; i + 1 < b.length; i += 2) {
    swapped[i] = b[i + 1];
    swapped[i + 1] = b[i];
  }
  return swapped.toString('utf16le');
}

function ipynbOutline(text) {
  let nb;
  try {
    nb = JSON.parse(text);
  } catch {
    return null;
  }
  const heads = [];
  for (const cell of nb?.cells ?? []) {
    if (cell?.cell_type !== 'markdown') continue;
    const src = Array.isArray(cell.source) ? cell.source.join('') : String(cell.source ?? '');
    for (const line of src.split('\n')) {
      const m = line.match(/^\s{0,3}#{1,3}\s+(.+?)\s*$/);
      if (m) heads.push(m[1]);
    }
    if (heads.length >= MAX_ITEMS) break;
  }
  return heads.length ? finish('headings', heads) : null;
}

/**
 * @param {string} filePath
 * @returns {{kind:string, items:string[]}|null} kind ∈ headings / sheets / slides / title / columns / statements
 */
export function readOutline(filePath) {
  const ext = extOf(filePath);
  if (!OUTLINE_EXTENSIONS.has(ext)) return null;
  try {
    if (ext === 'docx' || ext === 'xlsx' || ext === 'pptx') {
      const size = fs.statSync(filePath).size;
      if (size > MAX_ZIP_BYTES || size < 22) return null;
      const zip = openZip(fs.readFileSync(filePath));
      if (ext === 'docx') return docxOutline(zip);
      if (ext === 'xlsx') return xlsxOutline(zip);
      return pptxOutline(zip);
    }
    if (ext === 'pdf') {
      const { buf, size } = readHead(filePath, 256 * 1024);
      let title = pdfTitle(buf);
      if (!title && size > buf.length) {
        // Info 字典常在文件尾部
        const fd = fs.openSync(filePath, 'r');
        try {
          const tail = Buffer.alloc(Math.min(size, 256 * 1024));
          fs.readSync(fd, tail, 0, tail.length, size - tail.length);
          title = pdfTitle(tail);
        } finally {
          fs.closeSync(fd);
        }
      }
      return title ? finish('title', [title]) : null;
    }
    const { buf } = readHead(filePath);
    const text = decodeText(buf).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    if (ext === 'md' || ext === 'markdown' || ext === 'rst' || ext === 'adoc') return markdownOutline(text);
    if (ext === 'txt') return firstLineOutline(text);
    if (ext === 'csv') return csvOutline(text, ',');
    if (ext === 'tsv') return csvOutline(text, '\t');
    if (ext === 'sql') return sqlOutline(text);
    if (ext === 'ipynb') return ipynbOutline(text);
    return null;
  } catch {
    return null;
  }
}

/** 大纲种类的中文名，给日志与前端用。 */
export const OUTLINE_KIND_LABEL = { headings: '标题', sheets: '工作表', slides: '幻灯片', title: '首行', columns: '列', statements: '语句' };

/** 大纲压成一句：`标题：A ／ B ／ C` */
export function outlineText(outline, max = 5) {
  if (!outline?.items?.length) return '';
  const label = OUTLINE_KIND_LABEL[outline.kind] ?? outline.kind;
  const shown = outline.items.slice(0, max).join(' ／ ');
  const more = outline.items.length > max ? ` 等 ${outline.items.length} 项` : '';
  return `${label}：${shown}${more}`;
}
