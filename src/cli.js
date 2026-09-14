/**
 * CLI 入口。默认路径只有一条命令，不问任何问题（PROJECT_PLAN §4.1）。
 * 默认输出是**日记视图**（按模块聚合、带今日重点）；平铺的证据清单挪到 `evidence` 命令。
 */
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { loadConfig, saveConfig, dataDir, dbPath, configPath, syncDirWarning, maskConfig, aiProblems, dedupeRoots } from './config.js';
import { detectBrowsers } from './collect/browser.js';
import { detectShell, installShellHook, shellLogPath } from './collect/shell.js';
import { pickTemplate, templatesOf } from './ai/templates.js';
import { detectProviders } from './collect/sessions.js';
import { candidateRoots } from './setup.js';
import { dayRange, multiDayRange, datesIn, todayLocalDate, applyTimeZone, utcOffsetLabel, hhmm } from './time.js';
import { openDb, setDraft, logAiRun, aiUsageToday } from './db.js';
import { buildDay, saveJournal, writeOut } from './day.js';
import { buildFacts, validateReferences } from './facts.js';
import { renderMarkdown } from './render.js';
import { journalFromModules, allFacts, renderJournalMarkdown } from './journal.js';
import { buildPrompt, writeWithAI, SecretsFoundError, disclosure } from './ai/write.js';
import { WEB_PROJECT } from './modules.js';

const USAGE = `miztrace — 把今天的工作痕迹整理成每句话都能点回证据的日记

用法
  miztrace today [选项]            今天的日记（按模块聚合，带今日重点）
  miztrace date <YYYY-MM-DD>       指定日期的日记
  miztrace week [YYYY-MM-DD]       截止到该日的 7 天汇总
  miztrace modules [YYYY-MM-DD]    列出当天的模块（写日记的选择单位）
  miztrace evidence [YYYY-MM-DD]   平铺的证据清单（旧格式，调试用）
  miztrace write [YYYY-MM-DD]      用 AI 把被选中的模块写成日记（需先配置 ai）
  miztrace ui                      打开本地网页：戳泡泡选模块、配置模型、生成日记
  miztrace show <source_id>        查看某条证据（如 commit:a9c7471）
  miztrace sources                 本机能读到哪些来源：AI 工具、浏览器、终端钩子、推荐的扫描目录
  miztrace shell-hook [--install]  打印（或装上）记录终端命令的钩子；装完开个新终端即生效
  miztrace where                   打印数据目录与配置路径
  miztrace init                    写出默认配置文件
  miztrace purge                   删除全部本地数据（需 --yes）

选项
  --root <dir>      要扫描的目录，可重复；默认取配置或当前目录
  --out <dir>       把 Markdown 写到该目录（文件名 YYYY-MM-DD.md）
  --cutoff <hour>   本地日界小时，默认 4
  --tz <IANA>       指定时区，如 Asia/Shanghai；默认跟随本机时区
  --author <s>      只统计该作者的 commit
  --no-files        关闭文件系统扫描（只看 git 与 AI 会话）
  --no-browser      这一次不读浏览器历史（配置里开着也不读）
  --no-shell        这一次不读终端命令
  --template <id>   write：用哪个日记模板（summary / timeline / review / brief 或自定义 id）
  --preview         write：只打印将要发送的内容与估算，不联网
  --port <n>        ui：监听端口，默认随机
  --no-open         ui：不自动打开浏览器
  --json            输出结构化 JSON 而不是 Markdown
  --dry-run         不写数据库、不写文件
  --yes             purge 的确认标志
  -h, --help        显示本帮助

默认行为：不联网、不需要 API key、不读文件正文、不读 diff 正文；文档只读大纲，浏览器历史默认不读。
只有 write / ui 里的「生成日记」会按你配置的模型服务发请求，且发送前可预览。`;

const OPTIONS = {
  root: { type: 'string', multiple: true },
  out: { type: 'string' },
  cutoff: { type: 'string' },
  tz: { type: 'string' },
  author: { type: 'string' },
  port: { type: 'string' },
  json: { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  'no-files': { type: 'boolean', default: false },
  'no-browser': { type: 'boolean', default: false },
  'no-shell': { type: 'boolean', default: false },
  install: { type: 'boolean', default: false },
  template: { type: 'string' },
  'no-open': { type: 'boolean', default: false },
  preview: { type: 'boolean', default: false },
  yes: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
};

export async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${USAGE}\n`);
    return 2;
  }
  const { values: flags, positionals } = parsed;
  const command = positionals[0] ?? 'today';
  if (flags.help || command === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const cfg = loadConfig();
  if (flags.tz) cfg.timezone = flags.tz;
  try {
    cfg.effectiveTimezone = applyTimeZone(cfg.timezone); // 必须在任何日期计算之前生效
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 2;
  }
  if (flags.root?.length) {
    cfg.roots = dedupeRoots(flags.root);
    cfg.rootsConfigured = true;
  }
  if (flags.out) cfg.out = flags.out;
  if (flags.author) cfg.authorFilter = flags.author;
  if (flags.cutoff !== undefined) {
    const h = Number.parseInt(flags.cutoff, 10);
    if (!Number.isInteger(h) || h < 0 || h > 23) {
      process.stderr.write('--cutoff 必须是 0-23 的整数\n');
      return 2;
    }
    cfg.cutoffHour = h;
  }
  const dateArg = (i) => positionals[i] ?? todayLocalDate(cfg.cutoffHour);

  switch (command) {
    case 'today':
      return runJournal(cfg, dayRange(todayLocalDate(cfg.cutoffHour), cfg.cutoffHour), flags);
    case 'date': {
      if (!positionals[1]) {
        process.stderr.write('用法：miztrace date <YYYY-MM-DD>\n');
        return 2;
      }
      return runJournal(cfg, dayRange(positionals[1], cfg.cutoffHour), flags);
    }
    case 'week':
      return runJournal(cfg, multiDayRange(dateArg(1), 7, cfg.cutoffHour), flags);
    case 'modules':
      return runModules(cfg, dayRange(dateArg(1), cfg.cutoffHour), flags);
    case 'evidence':
      return runEvidence(cfg, dayRange(dateArg(1), cfg.cutoffHour), flags);
    case 'write':
      return runWrite(cfg, dayRange(dateArg(1), cfg.cutoffHour), flags);
    case 'ui':
      return runUi(cfg, flags);
    case 'show':
      return showEvidence(positionals[1], flags);
    case 'where':
      return where();
    case 'sources':
      return sources(cfg, flags);
    case 'shell-hook':
      return shellHook(cfg, flags);
    case 'init':
      return init(cfg);
    case 'purge':
      return purge(flags);
    default:
      process.stderr.write(`未知命令：${command}\n\n${USAGE}\n`);
      return 2;
  }
}

function footer(cfg) {
  return `时区 ${cfg.effectiveTimezone ?? '本机'}（UTC${utcOffsetLabel()}），日界 ${String(cfg.cutoffHour).padStart(2, '0')}:00，全部时间戳按 UTC 存储。`;
}

/**
 * 默认命令：模块 → 日记（规则版），带引用校验。
 * today / date 是单日；week 是多日区间：引用校验要放宽到区间内的每一天，
 * 落盘文件名加 -week 后缀，且不写 journals 表 —— 否则周汇总会把当天的日记文件和记录一并覆盖。
 */
function runJournal(cfg, range, flags) {
  const db = openDb(flags['dry-run'] ? ':memory:' : dbPath());
  try {
    const dates = datesIn(range, cfg.cutoffHour);
    const multiDay = dates.length > 1;
    const day = buildDay(cfg, range, flags, db);
    const journal = journalFromModules(day.modules);
    const { downgraded } = validateReferences(db, allFacts(journal), dates);
    if (downgraded && !flags.json) process.stderr.write(`引用校验：${downgraded} 条因来源缺失被降级为 unverified\n`);
    const heading = multiDay ? `${dates[0]} ～ ${range.localDate}（${dates.length} 天汇总）` : undefined;
    const markdown = renderJournalMarkdown(journal, { localDate: range.localDate, heading, evidenceIndex: day.evidenceIndex, footer: footer(cfg), source: 'rules' });
    if (flags.json) {
      process.stdout.write(`${JSON.stringify({ localDate: range.localDate, range, dates, modules: day.modules, journal, markdown }, null, 2)}\n`);
    } else {
      process.stdout.write(`${markdown}\n`);
    }
    if (!flags['dry-run']) {
      const out = multiDay
        ? writeOut(cfg, `${range.localDate}-${dates.length === 7 ? 'week' : `${dates.length}d`}`, markdown, { json: true })
        : saveJournal(db, cfg, range.localDate, markdown);
      if (out && !flags.json) process.stderr.write(`已写入 ${out}\n`);
    }
    return 0;
  } finally {
    db.close();
  }
}

/** 旧的平铺证据视图，调试用。 */
function runEvidence(cfg, range, flags) {
  const db = openDb(flags['dry-run'] ? ':memory:' : dbPath());
  try {
    const day = buildDay(cfg, range, flags, db);
    const { ctx } = day;
    const facts = buildFacts({ projects: ctx.projects, gitByProject: ctx.gitByProject, sessionsByProject: ctx.sessionsByProject, filesByProject: ctx.filesByProject, webPages: ctx.web.pages }, range.localDate);
    validateReferences(db, facts, datesIn(range, cfg.cutoffHour));
    const markdown = renderMarkdown({
      localDate: range.localDate,
      projects: ctx.web.pages.length ? [...ctx.projects, { ...WEB_PROJECT, rootPath: null }] : ctx.projects,
      facts,
      evidenceIndex: day.evidenceIndex,
      report: ctx.report,
      cutoffHour: cfg.cutoffHour,
      repoCount: ctx.repos.length,
      fileScan: ctx.fileScanOn ? ctx.fileScan.stats : null,
      timeZone: cfg.effectiveTimezone,
      utcOffset: utcOffsetLabel(),
    });
    process.stdout.write(flags.json ? `${JSON.stringify({ localDate: range.localDate, facts }, null, 2)}\n` : `${markdown}\n`);
    return 0;
  } finally {
    db.close();
  }
}

function runModules(cfg, range, flags) {
  const db = openDb(flags['dry-run'] ? ':memory:' : dbPath());
  try {
    const { modules } = buildDay(cfg, range, flags, db);
    if (flags.json) {
      process.stdout.write(`${JSON.stringify({ localDate: range.localDate, modules }, null, 2)}\n`);
      return 0;
    }
    const lines = [`${range.localDate} 共 ${modules.length} 个模块（按权重排序）`, ''];
    for (const m of modules) {
      const mark = m.selected ? '●' : '○';
      const time = m.durationMin ? `${hhmm(m.startTs)}-${hhmm(m.endTs)}` : hhmm(m.startTs);
      const bits = [];
      if (m.stats.commits) bits.push(`${m.stats.commits} 提交`);
      if (m.stats.prompts) bits.push(`${m.stats.prompts} 提问`);
      if (m.stats.commands) bits.push(`${m.stats.commands} 命令`);
      if (m.stats.files) bits.push(`${m.stats.files} 文件`);
      if (m.stats.pages) bits.push(`${m.stats.pages} 页面`);
      const tags = [m.permanentlyExcluded ? '永久排除' : null, m.overridden ? '手动' : null, m.burst ? '解压/复制' : null].filter(Boolean);
      lines.push(`${mark} [${m.category}] ${m.title}${tags.length ? `  〔${tags.join('，')}〕` : ''}`);
      lines.push(`    ${m.projectName}｜${time}｜${bits.join('、') || '无'}｜权重 ${m.score}`);
    }
    lines.push('', '● = 写进日记，○ = 排除。用 miztrace ui 在网页里逐个切换。');
    process.stdout.write(`${lines.join('\n')}\n`);
    return 0;
  } finally {
    db.close();
  }
}

/** AI 写日记。--preview 只打印将发送的内容，不联网。 */
async function runWrite(cfg, range, flags) {
  const db = openDb(flags['dry-run'] ? ':memory:' : dbPath());
  try {
    const day = buildDay(cfg, range, flags, db);
    const selected = day.modules.filter((m) => m.selected);
    const template = pickTemplate(cfg, flags.template);
    const prompt = buildPrompt({ localDate: range.localDate, modules: selected, hints: day.dayState.hints, style: cfg.ai?.style, template });
    const problems = aiProblems(cfg.ai);
    if (flags.preview || (flags.json && problems.length)) {
      const out = {
        localDate: range.localDate,
        modules: selected.map((m) => m.title),
        estTokens: prompt.estTokens,
        chars: prompt.user.length,
        secretHits: prompt.secretHits,
        aiConfigured: problems.length === 0,
        aiProblems: problems,
        disclosure: disclosure(cfg),
      };
      if (flags.json) process.stdout.write(`${JSON.stringify({ ...out, system: prompt.system, user: prompt.user }, null, 2)}\n`);
      else {
        const d = disclosure(cfg);
        process.stdout.write(`将发送 ${selected.length} 个模块，约 ${prompt.estTokens} tokens（${prompt.user.length} 字符），模板「${template.name}」。\n`);
        process.stdout.write(`包含：${d.includes.join('、')}。不含：${d.excludes.join('、')}。\n`);
        if (prompt.hintCount) process.stdout.write(`其中 ${prompt.hintCount} 个模块带你在网页里写的补充说明。\n`);
        if (prompt.secretHits.length) process.stdout.write(`⚠ 检测到疑似密钥，正式发送会被熔断：${prompt.secretHits.map((h) => `${h.kind}@${h.module}`).join('、')}\n`);
        process.stdout.write(`\n===== system =====\n${prompt.system}\n\n===== user =====\n${prompt.user}\n`);
      }
      return 0;
    }
    if (cfg.managedDevice === true) {
      process.stderr.write('这台电脑是受管设备（config.json 的 managedDevice=true）：AI 写作与一切外发已永久禁用。规则版日记 miztrace today 不受影响。\n');
      return 2;
    }
    if (problems.length) {
      process.stderr.write(`模型服务还差：${problems.join('、')}。跑 miztrace ui 在设置里填好，或编辑 config.json 的 ai 段。\n`);
      return 2;
    }
    const usage = aiUsageToday(db, range.localDate);
    if (cfg.ai.dailyLimit && usage.calls >= cfg.ai.dailyLimit) {
      process.stderr.write(`今天已调用 ${usage.calls} 次，达到 dailyLimit=${cfg.ai.dailyLimit}。\n`);
      return 2;
    }
    let res;
    try {
      res = await writeWithAI(cfg, { localDate: range.localDate, modules: selected, hints: day.dayState.hints, template, images: day.dayState.notes.images });
    } catch (err) {
      const r = err.result ?? {};
      logAiRun(db, { localDate: range.localDate, protocol: r.protocol ?? cfg.ai.protocol, model: r.model ?? cfg.ai.model, inputTokens: r.usage?.input, outputTokens: r.usage?.output, latencyMs: r.latencyMs, ok: false, error: err.message });
      process.stderr.write(`${err instanceof SecretsFoundError ? '熔断：' : '失败：'}${err.message}\n`);
      return 1;
    }
    logAiRun(db, { localDate: range.localDate, protocol: res.result.protocol, model: res.result.model, inputTokens: res.result.usage.input, outputTokens: res.result.usage.output, latencyMs: res.result.latencyMs, ok: true });
    if (res.result.retriedWith && res.result.retriedWith > (Number(cfg.ai.maxTokens) || 0) && !flags['dry-run']) {
      cfg.ai.maxTokens = res.result.retriedWith; // 能用的预算存进配置，下次一次成功
      saveConfig(cfg);
    }
    res.journal.excludedCount = day.modules.length - selected.length;
    const { downgraded } = validateReferences(db, allFacts(res.journal), datesIn(range, cfg.cutoffHour));
    const markdown = renderJournalMarkdown(res.journal, { localDate: range.localDate, evidenceIndex: day.evidenceIndex, footer: footer(cfg), source: 'ai' });
    if (!flags['dry-run']) setDraft(db, range.localDate, markdown, { source: 'ai', usage: res.result.usage, model: res.result.model });
    if (flags.json) process.stdout.write(`${JSON.stringify({ markdown, usage: res.result.usage, model: res.result.model, downgraded }, null, 2)}\n`);
    else {
      process.stdout.write(`${markdown}\n`);
      process.stderr.write(`模型 ${res.result.model}｜输入 ${res.result.usage.input} / 输出 ${res.result.usage.output} tokens｜${res.result.latencyMs} ms${res.result.retriedWith ? `｜第一次输出预算不够，已按 ${res.result.retriedWith} 重试成功，并把 ai.maxTokens 改成了这个数` : ''}${downgraded ? `｜${downgraded} 条引用无效已降级` : ''}\n`);
    }
    return 0;
  } finally {
    db.close();
  }
}

async function runUi(cfg, flags) {
  const { startServer } = await import('./server/index.js');
  const port = flags.port ? Number.parseInt(flags.port, 10) : cfg.ui?.port || 0;
  const srv = await startServer({ cfg, port, open: !flags['no-open'] });
  process.stdout.write(`MizTrace 本地界面：${srv.url}\n只监听 127.0.0.1，带随机 token；关掉这个终端即停止。Ctrl+C 退出。\n`);
  // 一直跑到收到 Ctrl+C / kill；收到后关掉监听并关库，别留下半截 WAL。等不到连接断开就 2 秒后强退。
  await new Promise((resolve) => {
    const stop = (sig) => {
      process.stderr.write(`\n收到 ${sig}，正在关闭…\n`);
      Promise.race([srv.close(), new Promise((r) => setTimeout(r, 2000))]).finally(resolve);
    };
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
  });
  return 0;
}

function showEvidence(sid, flags) {
  if (!sid) {
    process.stderr.write('用法：miztrace show <source_id>，如 commit:a9c7471 或 session:<sid>#42\n');
    return 2;
  }
  const db = openDb(dbPath());
  try {
    const i = sid.indexOf(':');
    const type = i < 0 ? null : sid.slice(0, i);
    const ref = i < 0 ? sid : sid.slice(i + 1);
    const rows = (type
      ? db.prepare('SELECT * FROM evidence WHERE source_type = ? ORDER BY occurred_at').all(type)
      : db.prepare('SELECT * FROM evidence ORDER BY occurred_at').all()
    ).filter((r) => r.source_ref.startsWith(ref));
    if (!rows.length) {
      process.stderr.write('未找到证据：' + sid + '\n');
      return 1;
    }
    if (flags.json) {
      process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
      return 0;
    }
    for (const r of rows) {
      process.stdout.write(
        r.source_type + ':' + r.source_ref + '\n  项目 ' + (r.project_id ?? '-') + '｜级别 ' + r.level + '｜发生于 ' + r.occurred_at + '｜归属日 ' + r.local_date + '\n' +
          '  ' + (r.path ? '路径 ' + r.path + '\n  ' : '') + (r.excerpt ?? '') + '\n\n',
      );
    }
    return 0;
  } finally {
    db.close();
  }
}

function where() {
  const cfg = loadConfig();
  const tz = applyTimeZone(cfg.timezone);
  process.stdout.write(
    `数据目录：${dataDir()}\n数据库：${dbPath()}\n配置：${configPath()}\n` +
      `时区：${tz ?? '未知'}（UTC${utcOffsetLabel()}）${cfg.timezone ? '，来自 config.timezone' : '，跟随本机'}\n` +
      `日界：每天本地 ${String(cfg.cutoffHour).padStart(2, '0')}:00\n` +
      `AI：${aiProblems(cfg.ai).length === 0 ? `已配置（${cfg.ai.protocol} / ${cfg.ai.model}）` : `未配置，还差 ${aiProblems(cfg.ai).join('、')}`}\n` +
      `浏览器历史：${cfg.browser?.enabled ? '开' : '关'}｜终端命令：${cfg.shell?.enabled ? '开' : '关'}｜文档大纲：${cfg.fileScan?.outline !== false ? '开' : '关'}｜助手回复：${cfg.sessions?.replies !== false ? '开' : '关'}\n` +
      `日记模板：${pickTemplate(cfg).name}（${templatesOf(cfg).map((t) => t.id).join(' / ')}）\n`,
  );
  const warn = syncDirWarning();
  if (warn) process.stdout.write(`\n警告：${warn}\n`);
  process.stdout.write('\n删除全部数据：miztrace purge --yes\n');
  return 0;
}

/** 本机能读到什么：给 Windows 上排查「为什么只有 Codex」用。 */
function sources(cfg, flags) {
  const providers = detectProviders(cfg.sessionDirs, cfg.roots);
  const browsers = detectBrowsers();
  const candidates = candidateRoots({ sessionDirs: cfg.sessionDirs, cwd: process.cwd(), roots: cfg.rootsConfigured ? cfg.roots : [] });
  const shell = detectShell(cfg);
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ roots: cfg.roots, rootsConfigured: cfg.rootsConfigured, providers, browsers, shell, candidates, disclosure: disclosure(cfg) }, null, 2)}\n`);
    return 0;
  }
  const lines = [];
  lines.push(`扫描目录（${cfg.rootsConfigured ? '来自配置' : '未配置，退回到当前目录'}）：`);
  for (const r of cfg.roots) lines.push(`  ${r}`);
  const found = providers.filter((p) => p.found);
  lines.push('', `AI 工具（支持 ${providers.length} 种，这台电脑上找到 ${found.length} 种）：`);
  for (const p of found) lines.push(`  ● ${p.name}${p.generic ? '（通用格式，尽力读）' : ''}：${p.dirs.join('，')}`);
  if (!found.length) lines.push('  没有找到任何 AI 编码工具的会话目录');
  lines.push('', `浏览器历史（${cfg.browser?.enabled ? '已开启' : '未开启，网页设置里可打开'}）：`);
  if (!browsers.length) lines.push('  没有检测到浏览器的历史记录文件');
  for (const b of browsers) for (const p of b.profiles) lines.push(`  ${p.readable ? '●' : '○'} ${b.name}（${p.profile}）${p.readable ? '' : `：${p.error}`}`);
  lines.push('', `终端命令（${shell.enabled ? '已开启' : '未开启'}）：`);
  lines.push(`  日志：${shell.file}${shell.exists ? `（${shell.lines} 条）` : '（还没有）'}`);
  for (const h of shell.shells) lines.push(`  ${h.installed ? '●' : '○'} ${h.name}：${h.installed ? '钩子已装' : h.profileExists ? '未装钩子' : '未装钩子（配置文件也不存在）'}  ${h.profile}`);
  if (!shell.shells.some((h) => h.installed)) lines.push('  装钩子：miztrace shell-hook --install（装完开个新终端）');
  lines.push('', '推荐的扫描目录：');
  for (const c of candidates.slice(0, 8)) lines.push(`  ${c.path}  —— ${c.reason}`);
  lines.push('', `文档大纲：${cfg.fileScan?.outline !== false ? '开' : '关'}｜助手回复：${cfg.sessions?.replies !== false ? '开' : '关'}`);
  const d = disclosure(cfg);
  lines.push(`生成日记时发给模型的：${d.includes.join('、')}。不发：${d.excludes.join('、')}。`);
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

/** 打印或安装终端钩子。安装 = 往 shell 配置文件末尾追加一段，不改原有内容；同时把 shell.enabled 打开。 */
function shellHook(cfg, flags) {
  const status = detectShell(cfg);
  if (!flags.install) {
    process.stdout.write(`终端命令会记到：${shellLogPath(cfg)}\n只记你敲的命令和所在目录，不记输出；带凭据的命令不记。\n\n把下面这段加到对应的配置文件末尾，或直接跑 miztrace shell-hook --install：\n\n`);
    for (const h of status.shells) process.stdout.write(`# ${h.name} → ${h.profile}${h.installed ? '（已装）' : ''}\n${h.snippet}\n\n`);
    return 0;
  }
  const results = installShellHook(cfg);
  for (const r of results) {
    const word = r.status === 'installed' ? '已装到' : r.status === 'already' ? '早已装在' : `失败（${r.error}）`;
    process.stdout.write(`${r.id}：${word} ${r.profile}\n`);
  }
  if (!results.length) process.stdout.write('没有找到可写的 shell 配置文件。用 miztrace shell-hook 打印片段后手动加。\n');
  if (!cfg.shell?.enabled) {
    cfg.shell = { ...(cfg.shell ?? {}), enabled: true };
    saveConfig(cfg);
    process.stdout.write('已在配置里打开终端命令采集。\n');
  }
  process.stdout.write('开一个新终端后敲的命令才会被记下。\n');
  return results.some((r) => r.status === 'failed') ? 1 : 0;
}

function init(cfg) {
  const file = saveConfig(cfg);
  process.stdout.write(`已写出配置：${file}\n\n${JSON.stringify(maskConfig(cfg), null, 2)}\n`);
  return 0;
}

function purge(flags) {
  const dir = dataDir();
  if (!flags.yes) {
    process.stderr.write(`这会删除整个数据目录：${dir}\n确认请加 --yes\n`);
    return 2;
  }
  if (!fs.existsSync(dir)) {
    process.stdout.write(`数据目录不存在，无需删除：${dir}\n`);
    return 0;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  process.stdout.write(`已删除：${dir}\n`);
  return 0;
}
