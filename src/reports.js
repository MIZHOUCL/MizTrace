/** 周期报告只使用用户已保存的记录，不重新扫描历史工作目录。 */
import { getDayState } from './db.js';
import { listLibraryDocuments, readLibraryDocument, validateJournalDate } from './journal-library.js';
import { digest, journalError } from './journal-files.js';
import { stripAnnotations } from './journal.js';

export const REPORT_TEMPLATES = [
  { id: 'work', name: '工作汇报', description: '适合发给主管：重点进展、项目成果、风险与下一步。', sections: ['重点进展', '项目进展与成果', '问题与风险', '下一步计划'] },
  { id: 'engineering', name: '研发交付', description: '适合开发协作：交付、验证进展、技术问题与待办。', sections: ['交付摘要', '研发进展', '技术问题与风险', '后续工作'] },
  { id: 'review', name: '个人复盘', description: '适合成长记录：本期进展、经验与发现、卡点、行动。', sections: ['本期回顾', '做了什么', '经验与发现', '遇到的问题', '接下来的行动'] },
];
export function reportOptions(input) {
  const start = validateJournalDate(input.start), end = validateJournalDate(input.end);
  const days = Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1;
  if (days < 1 || days > 62) throw journalError('开始日期不能晚于结束日期，一次最多汇总 62 天');
  const kind = input.kind;
  if (!['week', 'month'].includes(kind)) throw journalError('请选择周报或月报');
  const template = REPORT_TEMPLATES.find((t) => t.id === input.template);
  if (!template) throw journalError('请选择有效的报告模板');
  return { start, end, kind, template: template.id, days, lang: input.lang === 'en' ? 'en' : 'zh' };
}
const normalized = (s) => stripAnnotations(s).replace(/\r\n/g, '\n').trim();
export function reportSources(db, cfg, input) {
  const options = reportOptions(input), { start, end } = options;
  const listed = listLibraryDocuments(db, cfg);
  const sources = [], warnings = [...listed.warnings], seen = new Map();
  const candidates = listed.documents.filter((d) => d.kind !== 'report' && d.date >= start && d.date <= end)
    .sort((a, b) => a.date.localeCompare(b.date) || ({ file: 0, journal: 1, draft: 2 }[a.kind] - { file: 0, journal: 1, draft: 2 }[b.kind]));
  let duplicateCount = 0;
  for (const item of candidates) {
    try {
      validateJournalDate(item.date);
      const doc = readLibraryDocument(db, cfg, item.id), content = normalized(doc.markdown);
      if (!content) continue;
      const key = `${doc.date}:${digest(content)}`;
      if (seen.has(key)) { duplicateCount++; continue; }
      seen.set(key, true);
      // 不默认叠加当天草稿和定稿，保留草稿供用户显式选择。
      sources.push({ id: doc.id, date: doc.date, title: doc.title, kind: doc.kind, content,
        revision: doc.revision, selected: doc.kind !== 'draft' || !sources.some((s) => s.date === doc.date) });
    } catch (e) { warnings.push(`无法读取「${item.title}」：${e.message}`); }
  }
  for (const row of db.prepare('SELECT local_date FROM day_state WHERE local_date BETWEEN ? AND ? ORDER BY local_date').all(start, end)) {
    const entries = getDayState(db, row.local_date).notes.entries.filter((e) => e.text.trim());
    if (!entries.length) continue;
    const content = entries.map((e) => e.text.trim()).join('\n\n');
    sources.push({ id: `notes:${row.local_date}`, date: row.local_date, kind: 'notes', title: `${row.local_date} 手记`, content, revision: digest(content), selected: true });
  }
  const undated = listed.documents.filter((d) => d.kind === 'file' && !d.date).length;
  if (undated) warnings.push(`${undated} 篇 Markdown 未标注日期，不自动归入本期。文件名以 YYYY-MM-DD 开头后即可识别。`);
  if (duplicateCount) warnings.push(`已合并 ${duplicateCount} 份同日相同正文的副本。`);
  if (sources.some((s) => !s.selected)) warnings.push('同日已有记录的生成草稿默认不选，避免重复或使用旧版本；可手动切换。');
  return { options, sources, warnings };
}
export function selectedReportSources(db, cfg, input) {
  if (!Array.isArray(input.sourceIds) || !input.sourceIds.length || input.sourceIds.length > 120 || input.sourceIds.some((s) => typeof s !== 'string')) throw journalError('请选择 1–120 份素材');
  const result = reportSources(db, cfg, input), ids = new Set(input.sourceIds);
  const sources = result.sources.filter((s) => ids.has(s.id));
  if (sources.length !== ids.size) throw journalError('部分素材已移除或不在当前日期范围，请重新加载素材', 409, 'SOURCES_CHANGED');
  if (sources.reduce((n, s) => n + s.content.length, 0) > 60_000) throw journalError('选中正文超过 6 万字符，请减少素材或缩小日期范围；不会静默截断正文', 413);
  return { ...result, sources };
}
