// 只统一不改变含义的数字写法；不推导比例、单位换算或新指标。
const DIGITS = '零一二三四五六七八九';
const UNITS = { 十: 10, 百: 100, 千: 1000, 万: 10000, 亿: 100000000 };
function chineseNumber(value) {
  const s = value.replace(/〇/g, '零').replace(/两/g, '二');
  if ([...s].every((c) => DIGITS.includes(c))) return [...s].map((c) => DIGITS.indexOf(c)).join('');
  // “一百二”一类口语省略有歧义，不能擅自按 102 或 120 解释。
  if (/[百千万亿][一二三四五六七八九]$/.test(s) || /[一二三四五六七八九]{2}/.test(s)) return value;
  let total = 0, section = 0, digit = 0;
  for (const c of s) {
    if (DIGITS.includes(c)) { digit = DIGITS.indexOf(c); continue; }
    const unit = UNITS[c];
    if (unit < 10000) { section += (digit || 1) * unit; digit = 0; }
    else { section += digit; total = unit === 100000000 ? (total + section) * unit : total + section * unit; section = 0; digit = 0; }
  }
  return Number.isSafeInteger(total + section + digit) ? String(total + section + digit) : value;
}

export function reportNumbers(value, refs = []) {
  let text = String(value).normalize('NFKC');
  for (const ref of refs) text = text.replaceAll(`[${ref}]`, '').replaceAll(`[${ref.toUpperCase()}]`, '');
  // 排版序号不作为成果数字；正文中的实际数量仍须核验。
  text = text.replace(/^\s*\d+[.)、]\s+(?=\S)/gm, '');
  text = text.replace(/[零〇一二两三四五六七八九十百千万亿]+(?=\s*(?:项|个|条|次|人|天|小时|分钟|秒|毫秒|份|套|台|年|月|日|家|种|组|页|批|笔|处|步|轮|件|元|万元))/g, chineseNumber);
  text = text.replace(/(?<![\d,])\d{1,3}(?:,\d{3})+(?:\.\d+)?(?![\d,])/g, (s) => s.replaceAll(',', ''));
  text = text.replace(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?/g, (_, y, m, d) => `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`);
  const tokens = text.match(/\d{4}-\d{2}-\d{2}|[+-]?\d+(?:\.\d+)*(?:\s*%)?|[零〇一二两三四五六七八九十百千万亿]+(?=\s*(?:项|个|条|次|人|天|小时|分钟|秒|份|台|元))/g) ?? [];
  return tokens.map((s) => {
    const compact = s.replace(/\s/g, '');
    // 多段版本号与日期保持原样。数字 1 与 1.0 等价；符号、百分号保留。
    return compact.replace(/^([+-]?\d+)\.([0-9]+)(%)?$/, (_, n, fraction, percent = '') => {
      const trimmed = fraction.replace(/0+$/, '');
      return n + (trimmed ? '.' + trimmed : '') + percent;
    });
  });
}

export function unsupportedReportNumbers(value, evidence, refs = []) {
  const supported = new Set(reportNumbers(evidence, refs));
  return [...new Set(reportNumbers(value, refs).filter((n) => !supported.has(n)))];
}
