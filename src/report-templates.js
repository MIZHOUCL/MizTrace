/** 报告模板控制选材、表达和章节；与日记模板独立保存。 */
import { journalError } from './journal-files.js';

/** 参照工作计划/总结表；How much 包含结果、效果和已记录的资源投入。 */
export const FIVE_W_TWO_H_FIELDS = [
  ['category', '类别', 'Category'], ['pdca', 'PDCA 工作内容', 'PDCA activity'],
  ['why', '目的 / 问题点（Why）', 'Purpose / problem (Why)'],
  ['what', '工作内容 / 改善目标（What）', 'Work / improvement goal (What)'],
  ['how', '解决方案（How）', 'Solution (How)'],
  ['howMuch', '工作结果 / 达到效果（How much）', 'Results / impact (How much)'],
  ['when', '计划完成时间（When）', 'Target completion date (When)'],
  ['where', '执行单位（Where）', 'Executing team (Where)'],
  ['who', '责任人（Who）', 'Owner (Who)'], ['leader', '责任领导', 'Accountable lead'],
  ['completion', '完成情况', 'Completion'], ['remarks', '备注', 'Notes'],
];

export const REPORT_TEMPLATES = [
  { id: 'work', name: '工作汇报', description: '适合发给主管：重点进展、项目成果、风险与下一步。',
    sections: ['重点进展', '项目进展与成果', '问题与风险', '下一步计划'],
    englishSections: ['Key progress', 'Project progress and outcomes', 'Issues and risks', 'Next steps'],
    prompt: '面向主管写一份简洁的工作汇报，按项目组织。优先写本期交付、修复、已形成的方案或结论，说明具体做了什么、带来什么已知结果。将明确仍在处理的问题和有依据的下一步单独整理，不把缺少后续反馈的事项列成未完成。摘要写实际内容，不只罗列状态。省略空泛评价和重复过程。' },
  { id: 'engineering', name: '研发交付', description: '适合开发协作：交付、验证进展、技术问题与待办。',
    sections: ['交付摘要', '研发进展', '技术问题与风险', '后续工作'],
    englishSections: ['Delivery summary', 'Engineering progress', 'Technical issues and risks', 'Next steps'],
    prompt: '面向研发同事写交付报告，按项目和具体问题整理。突出代码变更、问题定位、修复方案、接口或配置调整及已记录的验证结果。将“方案已形成”“修改已提交”“已部署验证”分清，不要求用户再回复一次完成确认。明确受阻的联调、失败的测试和已记录的后续工作单列；仅缺少验证记录时，描述已经产出的内容，不自行追加待办。' },
  { id: 'review', name: '个人复盘', description: '适合成长记录：本期进展、经验与发现、卡点、行动。',
    sections: ['本期回顾', '做了什么', '经验与发现', '遇到的问题', '接下来的行动'],
    englishSections: ['Period review', 'Work accomplished', 'Learnings', 'Challenges', 'Next actions'],
    prompt: '写给自己回顾，按项目整理本期做过的事、已形成的方案和得到的结论，用自然具体的语言。经验必须来自记录，不编造感悟。已经有解决方法的问题，说明方法本身；只有明确仍未解决的事才列为当前卡点。接下来的行动只采用记录中已有的计划，不为填满模板而推测。' },
  { id: '5w2h', name: '5W2H 工作总结与计划', layout: '5w2h',
    description: '参照工作计划与总结表：按事项列目的、内容、方案、效果、时间、单位和责任人，周报月报通用。',
    sections: ['本期工作总结', '下一期工作计划'],
    englishSections: ['Work summary for this period', 'Work plan for the next period'],
    prompt: '参照5W2H工作计划及工作总结表，先写本期工作总结，再写有明确记录的下一期工作计划；周报按周、月报按月汇总，不把每天记录机械拼接。每个项目下按具体事项整理：Why写目的或问题点；What写工作内容或改善目标；How写解决方案和采取的措施；How much写当前工作结果、达到效果，以及原文明确的数量、工时、费用等投入；When写原文明确的计划完成时间；Where写执行单位或实施范围；Who区分责任人和责任领导。同时保留有依据的类别、PDCA工作内容、完成情况和备注。字段取自原文短引句，缺失字段留空，由排版显示“未记录”，不能推测姓名、单位、期限、预算、收益或完成比例；记录日期不能自动当作计划完成时间。计划里的预期效果必须保留“计划/预计/目标”等表述，不能写成实际效果。不因用户没有再次回复“已完成”就写“推进中”；形成方案可作为本期产出，不冒充已经实施。已记录的未解决问题留在本期总结，只有明确的未来行动列入下一期计划；没有计划就说明未记录，不自动续写工作。' },
];

const cleanTemplate = (t) => ({ id: t.id, name: t.name, description: t.description || '', sections: [...t.sections], prompt: t.prompt,
  ...(t.layout === '5w2h' ? { layout: '5w2h' } : {}) });
export function reportTemplatesOf(cfg = {}) {
  const byId = new Map(REPORT_TEMPLATES.map((t) => [t.id, { ...cleanTemplate(t), englishSections: [...t.englishSections], builtin: true, modified: false }]));
  for (const t of Array.isArray(cfg.reports?.templates) ? cfg.reports.templates : []) {
    if (!t || !t.id || !t.prompt || !Array.isArray(t.sections)) continue;
    const base = byId.get(t.id);
    byId.set(t.id, { ...cleanTemplate(t), builtin: Boolean(base), modified: Boolean(base),
      ...(base && JSON.stringify(base.sections) === JSON.stringify(t.sections) ? { englishSections: base.englishSections } : {}) });
  }
  return [...byId.values()];
}

export function pickReportTemplate(cfg, id) {
  const template = reportTemplatesOf(cfg).find((t) => t.id === (id || cfg?.reports?.template || 'work'));
  if (!template) throw journalError('请选择有效的报告模板');
  return template;
}

/** 严格拒绝不完整设置，避免保存时静默截断用户写的提示词。只保存新增或改过的模板。 */
export function normalizeReportTemplates(incoming) {
  if (!Array.isArray(incoming) || incoming.length > 30) throw journalError('最多保存 30 个报告模板');
  const ids = new Set(), result = [];
  const text = (value, max, label, optional = false) => {
    if (typeof value !== 'string' || (!optional && !value.trim()) || value.length > max) throw journalError(`${label}${optional ? '' : '不能为空，且'}最多 ${max} 个字符`);
    return value.trim();
  };
  for (const t of incoming) {
    if (!t || typeof t !== 'object' || typeof t.id !== 'string' || !/^[\w-]{1,40}$/.test(t.id) || ids.has(t.id)) throw journalError('报告模板编号无效或重复');
    ids.add(t.id);
    if (!Array.isArray(t.sections) || !t.sections.length || t.sections.length > 10) throw journalError('请填写 1–10 个章节标题，每行一个');
    if (t.layout !== undefined && !['narrative', '5w2h'].includes(t.layout)) throw journalError('报告展示方式无效');
    if (t.layout === '5w2h' && t.sections.length < 2) throw journalError('5W2H模板至少需要本期总结和下一期计划两个章节，最后一章用于计划');
    const item = { id: t.id, name: text(t.name, 40, '模板名称'), description: text(t.description ?? '', 300, '模板说明', true),
      prompt: text(t.prompt, 6000, '模板提示词'), sections: t.sections.map((s) => text(s, 80, '章节标题')),
      ...(t.layout === '5w2h' ? { layout: '5w2h' } : {}) };
    if (new Set(item.sections).size !== item.sections.length) throw journalError('章节标题不能重复');
    const builtin = REPORT_TEMPLATES.find((b) => b.id === item.id);
    if (!builtin || JSON.stringify(cleanTemplate(builtin)) !== JSON.stringify(cleanTemplate(item))) result.push(item);
  }
  return result;
}
