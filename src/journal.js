/**
 * 日记（journal）= 模块 → 章节。规则版与 AI 版共用同一套结构和渲染器，
 * 所以两条路径的输出都带脚注、都过引用完整性校验（ADR-006）。
 *
 * 结构：
 *   { highlights: fact[], sections: section[], excludedCount: number }
 *   section = { key, title, meta, category, projectName, facts: fact[] }
 *   fact    = { text, source_ids: string[], confidence, depth }
 */
import { hhmm } from './time.js';
import { defuseMarkdown, footnoteLabel } from './render.js';
import { OUTLINE_KIND_LABEL } from './collect/outline.js';

const KIND_LABEL = {
  prompt: '提问',
  reply: '回复',
  commit: '提交',
  clone: 'clone',
  file: '改动',
  'action-file': '改动',
  worktree: '改动',
  'action-command': '命令',
  'action-search': '搜索',
  shell: '终端',
  web: '浏览',
  note: '手记',
  image: '图片',
};

function fact(text, sourceIds, confidence = 'confirmed', depth = 0) {
  return { text, source_ids: [...new Set(sourceIds.filter(Boolean))], confidence, depth };
}

function statsLine(stats) {
  const bits = [];
  if (stats.commits) bits.push(`${stats.commits} 提交`);
  if (stats.clones) bits.push(`clone ${stats.clones} 个仓库`);
  if (stats.prompts) bits.push(`${stats.prompts} 提问`);
  if (stats.commands) bits.push(`${stats.commands} 命令`);
  if (stats.shell) bits.push(`${stats.shell} 终端命令`);
  if (stats.searches) bits.push(`${stats.searches} 搜索`);
  if (stats.files) bits.push(`${stats.files} 文件`);
  if (stats.pages) bits.push(`${stats.pages} 页面`);
  if (stats.notes) bits.push('手记');
  if (stats.images) bits.push(`${stats.images} 张图`);
  return bits.join(' · ') || '无';
}

/** 秒 → 「约 12 分钟」/「约 1.5 小时」；不到一分钟不值得写。 */
export function stayWords(secs) {
  const s = Number(secs) || 0;
  if (s < 60) return '';
  if (s < 3600) return `约 ${Math.round(s / 60)} 分钟`;
  return `约 ${(s / 3600).toFixed(1).replace(/\.0$/, '')} 小时`;
}

export function metaOf(m) {
  const time = m.durationMin ? `${hhmm(m.startTs)}–${hhmm(m.endTs)}` : hhmm(m.startTs);
  const tools = m.toolNames?.length ? ` ｜ ${m.toolNames.join('、')}` : '';
  return `${m.projectName}${tools} ｜ ${time} ｜ ${m.category} ｜ ${statsLine(m.stats)}`;
}

const cut = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** 文件条目带大纲时：`周报.docx（标题：本周进展 ／ 风险）` */
function fileLabel(f) {
  if (!f.outline?.length) return f.label;
  const kind = OUTLINE_KIND_LABEL[f.outlineKind] ?? '大纲';
  return `${f.label}（${kind}：${f.outline.slice(0, 4).join(' ／ ')}${f.outline.length > 4 ? ' …' : ''}）`;
}

/**
 * 规则版：从模块直接生成日记结构（零模型调用）。
 * @param {any[]} modules 含 selected
 */
export function journalFromModules(modules, opts = {}) {
  const { maxHighlights = 5, maxPrompts = 12, maxFiles = 8, maxCommands = 6, maxPages = 10 } = opts;
  const selected = modules.filter((m) => m.selected);
  const excluded = modules.filter((m) => !m.selected);

  const highlights = selected.slice(0, maxHighlights).map((m) =>
    fact(`**${m.title}**（${m.projectName}，${statsLine(m.stats)}）`, m.sourceIds.slice(0, 2)),
  );

  const sections = selected.map((m) => {
    const items = m.items ?? [];
    const facts = [];
    const commits = items.filter((i) => i.kind === 'commit');
    const clones = items.filter((i) => i.kind === 'clone');
    const shells = items.filter((i) => i.kind === 'shell');
    const prompts = items.filter((i) => i.kind === 'prompt');
    const replies = items.filter((i) => i.kind === 'reply');
    const files = items.filter((i) => i.kind === 'file' || i.kind === 'action-file' || i.kind === 'worktree');
    const commands = items.filter((i) => i.kind === 'action-command');
    const searches = items.filter((i) => i.kind === 'action-search');
    const pages = items.filter((i) => i.kind === 'web');
    const replyOf = new Map(replies.map((r) => [r.promptSourceId, r]));

    for (const n of items.filter((i) => i.kind === 'note')) facts.push(fact(n.label, [n.sourceId]));
    for (const im of items.filter((i) => i.kind === 'image')) facts.push(fact(`图片：${im.label}`, [im.sourceId]));
    for (const c of clones) facts.push(fact(c.label, [c.sourceId]));
    for (const c of commits) facts.push(fact(`提交「${c.label}」`, [c.sourceId]));
    for (const p of prompts.slice(0, maxPrompts)) {
      const rep = p.repeats > 1 ? `（重复 ${p.repeats} 次）` : '';
      facts.push(fact(`提问：${p.label}${rep}`, [p.sourceId, ...(p.altSourceIds ?? []).slice(0, 4)]));
      const r = replyOf.get(p.sourceId);
      // 回复紧跟在它答的那条提问下面：这是「AI 实际做了什么」的唯一直接证据
      if (r) facts.push(fact(`回复：${cut(r.label, 160)}`, [r.sourceId], 'confirmed', 1));
    }
    if (prompts.length > maxPrompts) {
      const rest = prompts.slice(maxPrompts);
      facts.push(fact(`另有 ${rest.length} 条提问`, rest.slice(0, 6).map((p) => p.sourceId)));
    }
    if (m.burst) {
      facts.push(fact(`新增项目 ${m.projectName}：${m.stats.files} 个文件同时出现（下载 / 解压 / 复制）`, files.slice(0, 6).map((f) => f.sourceId)));
    } else if (files.length) {
      const names = [...new Set(files.map((f) => f.label))];
      const shown = names.slice(0, maxFiles).join('、');
      const more = names.length > maxFiles ? ` 等 ${names.length} 个` : '';
      const fresh = files.filter((f) => f.created).length;
      facts.push(fact(`改动文件：${shown}${more}${fresh ? `（其中 ${fresh} 个是新出现的）` : ''}`, files.slice(0, 6).map((f) => f.sourceId)));
      // 有大纲的文档逐个再写一行：文件名只说明碰了哪个文件，大纲才说明文档讲什么
      const seen = new Set();
      for (const f of files.filter((x) => x.outline?.length)) {
        if (seen.has(f.label) || seen.size >= 5) continue;
        seen.add(f.label);
        facts.push(fact(fileLabel(f), [f.sourceId], 'confirmed', 1));
      }
    }
    if (commands.length) {
      const shown = commands.slice(0, maxCommands).map((c) => `\`${c.label}\``).join('、');
      const more = commands.length > maxCommands ? ` 等 ${commands.length} 条` : '';
      facts.push(fact(`执行命令：${shown}${more}`, commands.slice(0, 6).map((c) => c.sourceId)));
    }
    if (shells.length) {
      const shown = shells.slice(0, maxCommands).map((c) => `\`${c.label}\``).join('、');
      const more = shells.length > maxCommands ? ` 等 ${shells.length} 条` : '';
      facts.push(fact(`终端里敲了：${shown}${more}`, shells.slice(0, 6).map((c) => c.sourceId)));
    }
    if (searches.length) {
      const shown = searches.slice(0, maxCommands).map((c) => `「${c.label}」`).join('、');
      const more = searches.length > maxCommands ? ` 等 ${searches.length} 次` : '';
      facts.push(fact(`联网搜索：${shown}${more}`, searches.slice(0, 6).map((c) => c.sourceId)));
    }
    if (pages.length) {
      // 搜索词排在前面：它最能说明当时在找什么
      const ordered = [...pages.filter((p) => p.term), ...pages.filter((p) => !p.term)];
      for (const p of ordered.slice(0, maxPages)) {
        const times = p.repeats > 1 ? `，${p.repeats} 次` : '';
        const stay = stayWords(p.secs);
        facts.push(fact(p.term ? `搜索「${p.term}」${times}` : `浏览：${cut(p.label, 60)}（${p.host}${times}${stay ? `，停留${stay}` : ''}）`, [p.sourceId]));
      }
      if (ordered.length > maxPages) {
        const rest = ordered.slice(maxPages);
        facts.push(fact(`另有 ${rest.length} 个页面`, rest.slice(0, 6).map((p) => p.sourceId)));
      }
    }
    return { key: m.key, title: m.title, meta: metaOf(m), category: m.category, projectName: m.projectName, facts };
  });

  return { highlights, sections, excludedCount: excluded.length };
}

/** 把日记里所有 fact 摊平，供 validateReferences 就地修改 confidence。 */
export function allFacts(journal) {
  return [...(journal.overview ?? []), ...journal.highlights, ...journal.sections.flatMap((s) => s.facts)];
}

/**
 * 落盘 / 复制用的干净版：去掉引用上标、脚注、置信度标记、末尾的统计行与「被排除」提示。
 * 用户的原话：「证据什么的就不要写进日记中了，日记就写日记内容，证据什么的在前端看到就可以了」。
 * 网页里仍然渲染带脚注的版本（折叠着），可追溯性一点不少；只是文件里不再有 [^ev12] 这种符号。
 */
export function stripAnnotations(markdown) {
  const out = [];
  for (const raw of String(markdown ?? '').split('\n')) {
    if (/^\[\^ev\d+\]:/.test(raw)) continue;
    if (/^> (由 AI 依据证据撰写|由规则生成|另有 \d+ 个模块被排除|\d+ 个模块被排除|Written by AI|Generated by rules)/.test(raw)) continue;
    const line = raw
      .replace(/\[\^ev\d+\]/g, '')
      .replace(/ `(inferred|unverified)`/g, '')
      .replace(/（无法关联来源，请确认或删除）/g, '')
      .replace(/[ \t]+$/, '');
    out.push(line);
  }
  // 脚注前的分隔线没了脚注就多余；连续空行压成一个
  const text = out.join('\n').replace(/\n---\n+$/g, '\n').replace(/\n{3,}/g, '\n\n');
  return `${text.trim()}\n`;
}

/**
 * 渲染成 Markdown。必须在 validateReferences 之后调用（它会改 confidence）。
 * 被排除的模块只写数量，不写标题 —— 用户排除的可能正是隐私，标题也不能进落盘文件。
 */
export function renderJournalMarkdown(journal, meta) {
  // heading 可选：week 汇总用「起 ～ 止（N 天汇总）」当标题，默认就是当天日期
  const { localDate, heading, evidenceIndex, footer, source = 'rules', lang = 'zh' } = meta;
  const H = lang === 'en' ? { overview: '## Overview', process: '## Notes', highlights: '## Highlights', details: '## Details' } : { overview: '## 今日概览', process: '## 过程', highlights: '## 今日重点', details: '## 明细' };
  const lines = [`# ${heading ?? localDate}`, ''];
  const noteNo = new Map();
  const order = [];
  const refOf = (sid) => {
    if (!noteNo.has(sid)) {
      noteNo.set(sid, noteNo.size + 1);
      order.push(sid);
    }
    return noteNo.get(sid);
  };
  const renderFact = (f) => {
    const refs = f.source_ids.slice(0, 6).map((sid) => `[^ev${refOf(sid)}]`).join('');
    const mark = f.confidence === 'confirmed' ? '' : ` \`${f.confidence}\``;
    const hint = f.confidence === 'unverified' ? '（无法关联来源，请确认或删除）' : '';
    return `${'  '.repeat(f.depth ?? 0)}- ${defuseMarkdown(f.text)}${refs}${mark}${hint}`;
  };

  if (!journal.sections.length && !journal.highlights.length) {
    lines.push(`${heading ? '这段时间' : '今天'}没有可写进日记的内容。`, '');
    if (journal.excludedCount) lines.push(`> ${journal.excludedCount} 个模块被排除，未写入。`, '');
    if (footer) lines.push(`> ${footer}`, '');
    return lines.join('\n');
  }

  if (journal.prose && journal.overview?.length) {
    // AI 版第一层：几条总结性的结论，一眼知道今天做了什么（用户拿周报那种「- 完成 X；- 修复 Y」的写法当范本）
    lines.push(H.overview, '');
    for (const f of journal.overview) {
      const refs = f.source_ids.slice(0, 4).map((sid) => `[^ev${refOf(sid)}]`).join('');
      const mark = f.confidence === 'confirmed' ? '' : ` \`${f.confidence}\``;
      const hint = f.confidence === 'unverified' ? '（无法关联来源，请确认或删除）' : '';
      lines.push(`- ${defuseMarkdown(f.text)}${refs}${mark}${hint}`);
    }
    lines.push('');
    if (journal.sections.length) lines.push(H.process, '');
  } else if (journal.summary) {
    lines.push(defuseMarkdown(journal.summary.text) + journal.summary.source_ids.slice(0, 6).map((sid) => `[^ev${refOf(sid)}]`).join(''), '');
  }
  if (journal.highlights.length) {
    lines.push(H.highlights, '');
    journal.highlights.forEach((f, i) => {
      const refs = f.source_ids.slice(0, 6).map((sid) => `[^ev${refOf(sid)}]`).join('');
      const mark = f.confidence === 'confirmed' ? '' : ` \`${f.confidence}\``;
      lines.push(`${i + 1}. ${defuseMarkdown(f.text)}${refs}${mark}`);
    });
    lines.push('');
  }
  if (journal.prose) {
    // AI 版：散文。每节一段，小标题（若有）加粗放在段首，不打印模块 meta —— 日记不是模块报表。
    for (const s of journal.sections) {
      for (const f of s.facts) {
        const refs = f.source_ids.slice(0, 6).map((sid) => `[^ev${refOf(sid)}]`).join('');
        const mark = f.confidence === 'confirmed' ? '' : ` \`${f.confidence}\``;
        const hint = f.confidence === 'unverified' ? '（无法关联来源，请确认或删除）' : '';
        const lead = s.title ? `**${defuseMarkdown(s.title)}** ` : '';
        lines.push(`${lead}${defuseMarkdown(f.text)}${refs}${mark}${hint}`, '');
      }
    }
  } else if (journal.sections.length) {
    lines.push(H.details, '');
    for (const s of journal.sections) {
      lines.push(`### ${defuseMarkdown(s.title)}`, '');
      if (s.meta) lines.push(`_${defuseMarkdown(s.meta)}_`, '');
      for (const f of s.facts) lines.push(renderFact(f));
      lines.push('');
    }
  }
  if (journal.excludedCount) lines.push(`> 另有 ${journal.excludedCount} 个模块被排除，未写入本篇。`, '');

  if (order.length) {
    lines.push('---', '');
    for (const sid of order) lines.push(`[^ev${noteNo.get(sid)}]: ${footnoteLabel(evidenceIndex.get(sid))}`);
    lines.push('');
  }
  const facts = allFacts(journal);
  const counts = facts.reduce((acc, f) => ((acc[f.confidence] = (acc[f.confidence] ?? 0) + 1), acc), {});
  lines.push(
    `> 由 ${source === 'ai' ? 'AI 依据证据撰写' : '规则生成'}：${facts.length} 条，confirmed ${counts.confirmed ?? 0}，inferred ${counts.inferred ?? 0}，unverified ${counts.unverified ?? 0}。${footer ? ` ${footer}` : ''}`,
    '',
  );
  return lines.join('\n');
}

export { KIND_LABEL, statsLine };
