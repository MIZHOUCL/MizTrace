/**
 * 本地网页服务。整个仓库里**唯一**允许 node:http 的模块（入站、只绑 127.0.0.1）。
 *
 * 安全模型：
 * - 只监听 127.0.0.1，端口默认随机。
 * - 启动时生成随机 token；页面用 ?t= 拿到后放内存，API 请求带 X-MizTrace-Token，缺失或不对 → 401。
 * - 校验 Host / Origin 必须是本机，挡浏览器里其他网页的跨站请求。
 * - CSP 把页面锁死：只能加载本站资源、只能连本站。证据文本里若混进外链图片，渲染时也发不出去。
 * - 这个模块自己**不做任何出站请求**；出站只在 src/ai/。CI 用 grep 盯这两条。
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { saveConfig, maskConfig, mergeAiConfig, mergeBrowserConfig, mergeShellConfig, mergeSvnConfig, dbPath, aiProblems, dataDir, configPath, dedupeRoots } from '../config.js';
import { dayRange, todayLocalDate, utcOffsetLabel, hhmm } from '../time.js';
import { openDb, getDayState, setOverrides, setHint, setNotes, setDraft, logAiRun, aiUsageToday, MAX_NOTE_ENTRIES } from '../db.js';
import { addImage, removeImage, ALLOWED_MIME, MAX_IMAGE_BYTES } from '../notes.js';
import { buildDay, saveJournal } from '../day.js';
import { validateReferences } from '../facts.js';
import { journalFromModules, allFacts, renderJournalMarkdown, stripAnnotations } from '../journal.js';
import { buildPrompt, writeWithAI, SecretsFoundError, assertOutboundAllowed, disclosure } from '../ai/write.js';
import { testConnection } from '../ai/provider.js';
import { scrubSecrets } from '../ai/redact.js';
import { detectBrowsers } from '../collect/browser.js';
import { detectShell, installShellHook } from '../collect/shell.js';
import { templatesOf, pickTemplate, BUILTIN_TEMPLATES } from '../ai/templates.js';
import { detectProviders } from '../collect/sessions.js';
import { findWorkingCopies, svnAvailable } from '../collect/svn.js';
import { candidateRoots } from '../setup.js';

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.md': 'text/plain; charset=utf-8', '.woff2': 'font/woff2' };
const MAX_BODY = 1024 * 1024;
/** 传图的接口单独放宽：base64 比原图大三分之一。 */
const MAX_IMAGE_BODY = Math.ceil(MAX_IMAGE_BYTES * 1.4) + 64 * 1024;
export const VERSION = '0.3.0-dev';

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'content-type': isJson ? 'application/json; charset=utf-8' : headers['content-type'] ?? 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function isLocalHost(value, port) {
  if (!value) return false;
  try {
    const u = new URL(value.includes('://') ? value : `http://${value}`);
    return (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]' || u.hostname === '::1') && (!port || Number(u.port || 80) === port);
  } catch {
    return false;
  }
}

/** 前端传的界面语言：只认 zh / en，其余按中文。 */
function langOf(v) {
  return String(v ?? '').toLowerCase().startsWith('en') ? 'en' : 'zh';
}

function dateOr(value, cfg) {
  const d = String(value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : todayLocalDate(cfg.cutoffHour);
}

/** 只把模块引用到的证据发给前端，并去掉不需要的字段。 */
function evidenceFor(modules, evidenceIndex) {
  const out = {};
  for (const m of modules) {
    for (const sid of m.sourceIds) {
      const ev = evidenceIndex.get(sid);
      if (ev) out[sid] = { source_type: ev.source_type, source_ref: ev.source_ref, occurred_at: ev.occurred_at, excerpt: ev.excerpt, path: ev.path, path_alias: ev.path_alias, level: ev.level };
    }
  }
  return out;
}

function footerOf(cfg) {
  return `时区 ${cfg.effectiveTimezone ?? '本机'}（UTC${utcOffsetLabel()}），日界 ${String(cfg.cutoffHour).padStart(2, '0')}:00，全部时间戳按 UTC 存储。`;
}

/** 这一天看了哪些来源、各拿到多少：前端首屏那句「看过 …」用它写。 */
function sourcesOf(day) {
  const { ctx } = day;
  return {
    repos: ctx.repos.length,
    fileScan: ctx.fileScanOn ? ctx.fileScan.stats : null,
    files: ctx.fileScan.hits.length,
    outline: ctx.outlineOn ? ctx.outlineStats : null,
    sessions: ctx.report,
    browser: ctx.browserOn ? { report: ctx.web.report, ...ctx.web.stats } : null,
    shell: ctx.shellOn ? { commands: ctx.shell.commands.length, ...ctx.shell.stats } : null,
  };
}

const DIR_BLACKHOLES = new Set(['node_modules', 'Library', 'AppData', 'Applications', 'System', 'Windows', 'Program Files', 'Program Files (x86)', 'ProgramData', '$RECYCLE.BIN', 'System Volume Information', '.Trash']);

/** Windows 上存在的盘符；其它系统给 / 与家目录。 */
function driveRoots() {
  const home = os.homedir();
  if (process.platform !== 'win32') return [{ name: '家目录', path: home }, { name: '/', path: '/' }];
  const out = [{ name: '用户目录', path: home }];
  for (let c = 65; c <= 90; c += 1) {
    const d = `${String.fromCharCode(c)}:\\`;
    if (fs.existsSync(d)) out.push({ name: d, path: d });
  }
  return out;
}

export function listDirs(raw) {
  const roots = driveRoots();
  const target = String(raw ?? '').trim();
  if (!target) return { path: '', parent: null, dirs: [], roots, isRoot: true };
  const abs = path.resolve(target);
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch (err) {
    return { path: abs, parent: path.dirname(abs) === abs ? '' : path.dirname(abs), dirs: [], roots, error: err.code === 'EACCES' || err.code === 'EPERM' ? '没有权限读取这个目录' : '目录不存在或无法读取' };
  }
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !DIR_BLACKHOLES.has(e.name))
    .map((e) => ({ name: e.name, path: path.join(abs, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    .slice(0, 500);
  const parent = path.dirname(abs);
  return { path: abs, parent: parent === abs ? '' : parent, dirs, roots, home: os.homedir() };
}

/** 给前端的手记：不带文件路径。entries = 已保存的手记（一条一个泡泡），images 用 entryId 认领到各自的手记上。 */
function publicNotes(notes) {
  return {
    entries: (notes?.entries ?? []).map((e) => ({ id: e.id, text: e.text, ts: e.ts ?? null })),
    images: (notes?.images ?? []).map((i) => ({ id: i.id, name: i.name, mime: i.mime, bytes: i.bytes, ts: i.ts, entryId: i.entryId ?? null, forKey: i.forKey ?? null })),
  };
}

/** 字符串数组字段：每行一个，去空。 */
function lines(v) {
  if (Array.isArray(v)) return v.map((r) => String(r).trim()).filter(Boolean);
  if (typeof v === 'string') return v.split('\n').map((r) => r.trim()).filter(Boolean);
  return null;
}

/**
 * 把前端提交的配置补丁合并进 cfg。导出以便单测。
 * 只接受已知字段，数字要在合理范围内；apiKey 为空 / 掩码不覆盖旧值（mergeAiConfig 负责）。
 */
export function applyConfigPatch(cfg, body) {
  if (body.ai) cfg.ai = mergeAiConfig(cfg.ai, body.ai);
  if (typeof body.out === 'string') cfg.out = body.out.trim() || null;
  const roots = lines(body.roots);
  if (roots) {
    const clean = dedupeRoots(roots);
    cfg.roots = clean.length ? clean : [process.cwd()];
    cfg.rootsConfigured = clean.length > 0;
  }
  if (Number.isInteger(body.gapMinutes) && body.gapMinutes >= 5) cfg.gapMinutes = body.gapMinutes;
  if (Number.isInteger(body.cutoffHour) && body.cutoffHour >= 0 && body.cutoffHour <= 23) cfg.cutoffHour = body.cutoffHour;
  const excluded = lines(body.excludeProjects);
  if (excluded) cfg.excludeProjects = excluded;
  if (Array.isArray(body.projectRules)) {
    cfg.projectRules = body.projectRules
      .filter((r) => r && typeof r === 'object' && typeof r.repo === 'string' && typeof r.path === 'string' && typeof r.project === 'string')
      .map((r) => ({ repo: path.resolve(r.repo), path: r.path.replace(/^[/\\]+|[/\\]+$/g, ''), project: r.project.trim() }))
      .filter((r) => r.path && r.project);
  }
  if (typeof body.authorFilter === 'string') cfg.authorFilter = body.authorFilter.trim() || null;
  if (body.fileScan && typeof body.fileScan === 'object') {
    cfg.fileScan = { ...cfg.fileScan };
    if (typeof body.fileScan.enabled === 'boolean') cfg.fileScan.enabled = body.fileScan.enabled;
    if (typeof body.fileScan.outline === 'boolean') cfg.fileScan.outline = body.fileScan.outline;
  }
  if (body.sessions && typeof body.sessions === 'object') {
    cfg.sessions = { ...cfg.sessions };
    if (typeof body.sessions.replies === 'boolean') cfg.sessions.replies = body.sessions.replies;
  }
  if (body.browser && typeof body.browser === 'object') {
    const incoming = { ...body.browser };
    if (typeof incoming.excludeDomains === 'string') incoming.excludeDomains = lines(incoming.excludeDomains);
    cfg.browser = mergeBrowserConfig(cfg.browser, incoming);
  }
  if (body.shell && typeof body.shell === 'object') cfg.shell = mergeShellConfig(cfg.shell, body.shell);
  if (body.svn && typeof body.svn === 'object') cfg.svn = mergeSvnConfig(cfg.svn, body.svn);
  if (body.setupDone === true) cfg.setupDone = true;
  return cfg;
}

/**
 * @param {{cfg:any, port?:number, host?:string, open?:boolean, dbFile?:string}} opts
 * @returns {Promise<{url:string, port:number, token:string, close:()=>Promise<void>, server:http.Server}>}
 */
export async function startServer(opts) {
  const { cfg, host = '127.0.0.1', open = false } = opts;
  const token = crypto.randomBytes(16).toString('hex');
  const db = openDb(opts.dbFile ?? dbPath());
  const flags = { json: true, 'no-files': false };
  let boundPort = 0;

  /**
   * 采集结果按日期缓存两分钟。之前每个接口各自 buildDay（= 全量采集），用户点一下「生成日记」要等一次全扫，
   * 没有任何反馈，于是再点「规则版日记」又扫一次 —— 两个请求排着队，第一个的弹窗迟迟不出来，出来了按钮又是灰的。
   * 现在只有 GET /api/day?refresh=1（打开页面、切日期、改设置后）才真的重新采集；预览、生成、规则版都复用。
   * 落库、聚模块、套用勾选与手记每次照做（见 buildDay），所以缓存只影响「新出现的痕迹要等两分钟或点刷新」。
   */
  const DAY_CACHE_MS = 120_000;
  const dayCache = new Map(); // localDate -> { ctx, at }
  function dayOf(localDate, { refresh = false } = {}) {
    const hit = dayCache.get(localDate);
    const reuse = !refresh && hit && Date.now() - hit.at < DAY_CACHE_MS;
    const day = buildDay(cfg, dayRange(localDate, cfg.cutoffHour), flags, db, reuse ? { ctx: hit.ctx } : {});
    if (!reuse) dayCache.set(localDate, { ctx: day.ctx, at: Date.now() });
    return day;
  }

  const api = {
    async 'GET /api/state'() {
      return {
        today: todayLocalDate(cfg.cutoffHour),
        tz: cfg.effectiveTimezone,
        utcOffset: utcOffsetLabel(),
        config: maskConfig(cfg),
        version: VERSION,
        rootsConfigured: cfg.rootsConfigured === true,
        setupDone: cfg.setupDone === true,
        platform: process.platform,
        home: os.homedir(),
        dataDir: dataDir(),
        configPath: configPath(),
        disclosure: disclosure(cfg),
      };
    },
    /** 首次引导与设置页用：本机有什么可读。不解析内容，只做存在性 / 可读性检查。 */
    async 'GET /api/sources'() {
      return {
        roots: { configured: cfg.rootsConfigured === true, current: cfg.roots },
        candidates: candidateRoots({ sessionDirs: cfg.sessionDirs, cwd: process.cwd(), roots: cfg.rootsConfigured ? cfg.roots : [] }),
        providers: detectProviders(cfg.sessionDirs, cfg.roots),
        browsers: detectBrowsers().map((b) => ({ id: b.id, name: b.name, kind: b.kind, profiles: b.profiles.map((p) => ({ profile: p.profile, readable: p.readable, error: p.error })) })),
        fileScan: { enabled: cfg.fileScan?.enabled !== false, outline: cfg.fileScan?.outline !== false },
        sessions: { replies: cfg.sessions?.replies !== false },
        browser: { enabled: cfg.browser?.enabled === true, only: cfg.browser?.only ?? [], excludeDomains: cfg.browser?.excludeDomains ?? [] },
        shell: detectShell(cfg),
        // 工作副本的发现是纯文件系统遍历，不需要 svn 命令，所以没装 svn 也能在设置页里提示「你这儿有工作副本」
        svn: {
          available: svnAvailable(),
          enabled: cfg.svn?.enabled === true,
          remote: cfg.svn?.remote !== false,
          workingCopies: findWorkingCopies(cfg.roots, cfg.svn?.maxDepth ?? 4),
        },
        templates: templatesOf(cfg),
        builtinTemplates: BUILTIN_TEMPLATES,
        template: cfg.ai?.template ?? 'summary',
        disclosure: disclosure(cfg),
      };
    },
    /**
     * 目录浏览：给「选目录」用的。只列子目录，不列文件、不读内容；隐藏目录与体积黑洞不列。
     * 根：Windows 列各个盘符，其它列 / 与家目录。
     */
    async 'GET /api/fs/dirs'(q) {
      return listDirs(q.get('path') ?? '');
    },
    /** 把终端钩子写进 shell 配置文件；用户在设置里点了「安装」才会调。 */
    async 'POST /api/shell/install'(q, body) {
      const ids = Array.isArray(body.shells) ? body.shells.map(String) : [];
      const results = installShellHook(cfg, ids);
      if (body.enable !== false) {
        cfg.shell = mergeShellConfig(cfg.shell, { enabled: true });
        saveConfig(cfg);
        dayCache.clear();
      }
      return { results, shell: detectShell(cfg) };
    },
    async 'GET /api/day'(q) {
      const localDate = dateOr(q.get('date'), cfg);
      const day = dayOf(localDate, { refresh: q.get('refresh') === '1' });
      const state = getDayState(db, localDate);
      return {
        localDate,
        // 每个模块带上用户给它写的「补充说明」（hint），前端抽屉里直接显示、可改
        modules: day.modules.map((m) => ({ ...m, hint: state.hints[m.key] ?? '' })),
        notes: publicNotes(state.notes),
        evidence: evidenceFor(day.modules, day.evidenceIndex),
        report: day.ctx.report,
        fileScan: day.ctx.fileScanOn ? day.ctx.fileScan.stats : null,
        repoCount: day.ctx.repos.length,
        sources: sourcesOf(day),
        draft: state.draftMd ? { markdown: state.draftMd, clean: stripAnnotations(state.draftMd), meta: state.draftJson, updatedAt: state.updatedAt } : null,
        usage: aiUsageToday(db, localDate),
        excludeProjects: cfg.excludeProjects ?? [],
        hints: state.hints,
      };
    },
    async 'POST /api/day/override'(q, body) {
      const localDate = dateOr(body.date, cfg);
      const state = getDayState(db, localDate);
      const next = { ...state.overrides };
      if (typeof body.key !== 'string' || !body.key) throw new Error('缺少 key');
      if (body.selected === null || body.selected === undefined) delete next[body.key];
      else next[body.key] = Boolean(body.selected);
      setOverrides(db, localDate, next);
      return { ok: true, overrides: next };
    },
    /**
     * 新增一条手记（点「保存手记」时调）。一条手记 = 时间板上的一个泡泡。
     * 输入框里已经传好、还没有归属的图会一并挂到这条上。
     */
    async 'POST /api/day/note'(q, body) {
      const localDate = dateOr(body.date, cfg);
      const { notes } = getDayState(db, localDate);
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      const stray = notes.images.filter((i) => !i.forKey && !i.entryId);
      if (!text && !stray.length) throw new Error('手记是空的');
      if (notes.entries.length >= MAX_NOTE_ENTRIES) throw new Error(`一天最多 ${MAX_NOTE_ENTRIES} 条手记`);
      const id = crypto.randomBytes(4).toString('hex');
      const next = setNotes(db, localDate, {
        entries: [...notes.entries, { id, text, ts: new Date().toISOString() }],
        images: notes.images.map((i) => (i.forKey || i.entryId ? i : { ...i, entryId: id })),
      });
      return { ok: true, notes: publicNotes(next) };
    },
    /** 删掉一条手记：条目与它名下的图片文件一起删。 */
    async 'POST /api/day/note/delete'(q, body) {
      const localDate = dateOr(body.date, cfg);
      const { notes } = getDayState(db, localDate);
      const id = String(body.id ?? '');
      if (!id) throw new Error('缺少 id');
      for (const im of notes.images) if (im.entryId === id) removeImage(im);
      const next = setNotes(db, localDate, {
        entries: notes.entries.filter((e) => e.id !== id),
        images: notes.images.filter((i) => i.entryId !== id),
      });
      return { ok: true, notes: publicNotes(next) };
    },
    /** 传一张图：{ date, name, mime, data(base64), key? }。key = 给哪个泡泡补的图（不传就是手记的图）。文件落数据目录，清单进 day_state。 */
    async 'POST /api/day/image'(q, body) {
      const localDate = dateOr(body.date, cfg);
      const { notes } = getDayState(db, localDate);
      const forKey = typeof body.key === 'string' && body.key.trim() ? body.key.trim().slice(0, 200) : null;
      const image = { ...addImage(localDate, { name: body.name, mime: body.mime, data: body.data }, notes.images), ...(forKey ? { forKey } : {}) };
      const next = setNotes(db, localDate, { ...notes, images: [...notes.images, image] });
      return { ok: true, notes: publicNotes(next) };
    },
    async 'POST /api/day/image/delete'(q, body) {
      const localDate = dateOr(body.date, cfg);
      const { notes } = getDayState(db, localDate);
      const id = String(body.id ?? '');
      const gone = notes.images.find((i) => i.id === id);
      if (gone) removeImage(gone);
      const next = setNotes(db, localDate, { ...notes, images: notes.images.filter((i) => i.id !== id) });
      return { ok: true, notes: publicNotes(next) };
    },
    async 'POST /api/day/hint'(q, body) {
      const localDate = dateOr(body.date, cfg);
      if (typeof body.key !== 'string' || !body.key) throw new Error('缺少 key');
      const hints = setHint(db, localDate, body.key, typeof body.hint === 'string' ? body.hint : '');
      return { ok: true, hints };
    },
    async 'POST /api/day/reset'(q, body) {
      setOverrides(db, dateOr(body.date, cfg), {});
      return { ok: true };
    },
    async 'POST /api/project/exclude'(q, body) {
      const p = String(body.project ?? '').trim();
      if (!p) throw new Error('缺少 project');
      cfg.excludeProjects = [...new Set([...(cfg.excludeProjects ?? []), p])];
      saveConfig(cfg);
      return { ok: true, excludeProjects: cfg.excludeProjects };
    },
    async 'POST /api/project/include'(q, body) {
      const p = String(body.project ?? '').trim();
      cfg.excludeProjects = (cfg.excludeProjects ?? []).filter((x) => x !== p);
      saveConfig(cfg);
      return { ok: true, excludeProjects: cfg.excludeProjects };
    },
    async 'GET /api/journal'(q) {
      const localDate = dateOr(q.get('date'), cfg);
      const day = dayOf(localDate);
      const journal = journalFromModules(day.modules);
      const { downgraded } = validateReferences(db, allFacts(journal), localDate);
      const markdown = renderJournalMarkdown(journal, { localDate, evidenceIndex: day.evidenceIndex, footer: footerOf(cfg), source: 'rules', lang: langOf(q.get('lang')) });
      return { markdown, clean: stripAnnotations(markdown), downgraded, source: 'rules' };
    },
    async 'POST /api/write/preview'(q, body) {
      const localDate = dateOr(body.date, cfg);
      const day = dayOf(localDate);
      const selected = day.modules.filter((m) => m.selected);
      const template = pickTemplate(cfg, body.template);
      const prompt = buildPrompt({ localDate, modules: selected, hints: day.dayState.hints, style: cfg.ai?.style, template, lang: langOf(body.lang) });
      const problems = aiProblems(cfg.ai);
      const hintImages = selected.filter((m) => m.items?.some((it) => it.kind === 'image' && it.forKey)).map((m) => m.title);
      return {
        hintImages,
        localDate,
        template: { id: template.id, name: template.name },
        templates: templatesOf(cfg).map((t) => ({ id: t.id, name: t.name })),
        modules: selected.map((m) => ({ key: m.key, title: m.title, toolNames: m.toolNames ?? [] })),
        estTokens: prompt.estTokens,
        chars: prompt.user.length,
        secretHits: prompt.secretHits,
        hintCount: prompt.hintCount,
        imageCount: prompt.images.length,
        vision: cfg.ai?.vision === true,
        hasStyle: Boolean(String(cfg.ai?.style ?? '').trim()),
        system: prompt.system,
        user: prompt.user,
        aiConfigured: problems.length === 0,
        aiProblems: problems,
        model: cfg.ai?.model ?? '',
        managedDevice: cfg.managedDevice === true,
        usage: aiUsageToday(db, localDate),
        dailyLimit: cfg.ai?.dailyLimit ?? 0,
        disclosure: disclosure(cfg),
      };
    },
    async 'POST /api/write'(q, body) {
      const localDate = dateOr(body.date, cfg);
      assertOutboundAllowed(cfg);
      const problems = aiProblems(cfg.ai);
      if (problems.length) throw new Error(`模型服务还差：${problems.join('、')}。点右上角「设置」填好再试。`);
      const usage = aiUsageToday(db, localDate);
      if (cfg.ai.dailyLimit && usage.calls >= cfg.ai.dailyLimit) throw new Error(`今天已调用 ${usage.calls} 次，达到每日上限 ${cfg.ai.dailyLimit}`);
      const day = dayOf(localDate);
      const selected = day.modules.filter((m) => m.selected);
      const template = pickTemplate(cfg, body.template);
      if (body.template && template.id === body.template && cfg.ai.template !== template.id) {
        cfg.ai.template = template.id; // 记住这次选的模板，下次默认就是它
        saveConfig(cfg);
      }
      let res;
      try {
        res = await writeWithAI(cfg, { localDate, modules: selected, hints: day.dayState.hints, template, images: day.dayState.notes.images, lang: langOf(body.lang) });
      } catch (err) {
        const r = err.result ?? {};
        logAiRun(db, { localDate, protocol: r.protocol ?? cfg.ai.protocol, model: r.model ?? cfg.ai.model, inputTokens: r.usage?.input, outputTokens: r.usage?.output, latencyMs: r.latencyMs, ok: false, error: err.message });
        if (err instanceof SecretsFoundError) return { blocked: true, hits: err.hits, error: err.message };
        throw err;
      }
      logAiRun(db, { localDate, protocol: res.result.protocol, model: res.result.model, inputTokens: res.result.usage.input, outputTokens: res.result.usage.output, latencyMs: res.result.latencyMs, ok: true });
      // 第一次预算不够、加大后写成了：把能用的预算直接存进设置，下次一次成功，不用每次都白跑一趟
      if (res.result.retriedWith && res.result.retriedWith > (Number(cfg.ai.maxTokens) || 0)) {
        cfg.ai.maxTokens = res.result.retriedWith;
        saveConfig(cfg);
      }
      res.journal.excludedCount = day.modules.length - selected.length;
      const { downgraded } = validateReferences(db, allFacts(res.journal), localDate);
      const markdown = renderJournalMarkdown(res.journal, { localDate, evidenceIndex: day.evidenceIndex, footer: footerOf(cfg), source: 'ai', lang: langOf(body.lang) });
      setDraft(db, localDate, markdown, { source: 'ai', usage: res.result.usage, model: res.result.model, latencyMs: res.result.latencyMs, template: template.name });
      return { markdown, clean: stripAnnotations(markdown), usage: res.result.usage, model: res.result.model, latencyMs: res.result.latencyMs, downgraded, source: 'ai', template: template.name, retriedWith: res.result.retriedWith ?? null };
    },
    async 'POST /api/save'(q, body) {
      const localDate = dateOr(body.date, cfg);
      if (typeof body.markdown !== 'string' || !body.markdown.trim()) throw new Error('没有内容可保存');
      if (!cfg.out) throw new Error('未配置输出目录（设置里的「日记目录」）');
      // 落盘的是干净版：没有 [^evN] 上标、脚注和统计行。证据在网页里看；文件就是日记本身
      const outPath = saveJournal(db, cfg, localDate, body.clean === false ? body.markdown : stripAnnotations(body.markdown));
      setDraft(db, localDate, body.markdown, { source: body.source ?? 'edited', savedTo: outPath });
      return { ok: true, path: outPath };
    },
    async 'GET /api/config'() {
      return maskConfig(cfg);
    },
    async 'PUT /api/config'(q, body) {
      applyConfigPatch(cfg, body ?? {});
      // 首次引导里勾了「终端命令」：顺手把钩子装上，不然开关开了也没有数据
      if (body?.shell?.install === true) installShellHook(cfg);
      saveConfig(cfg);
      dayCache.clear(); // 扫描目录、来源开关变了，缓存的采集结果作废
      return maskConfig(cfg);
    },
    async 'POST /api/ai/test'(q, body) {
      assertOutboundAllowed(cfg);
      const ai = mergeAiConfig(cfg.ai, body.ai ?? {});
      return testConnection(ai);
    },
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${host}:${boundPort}`);
      const origin = req.headers.origin;
      if (!isLocalHost(req.headers.host, boundPort) || (origin && !isLocalHost(origin, boundPort))) {
        return send(res, 403, { error: '只接受本机访问' });
      }
      if (url.pathname.startsWith('/api/')) {
        // <img> 发不了自定义头：只有看图这一个 GET 接口允许把 token 放在 ?t=
        const tokenOk = req.headers['x-miztrace-token'] === token || (req.method === 'GET' && url.pathname === '/api/day/image' && url.searchParams.get('t') === token);
        if (!tokenOk) return send(res, 401, { error: '缺少或错误的 token，请从终端打印的地址重新打开页面' });
        if (req.method === 'GET' && url.pathname === '/api/day/image') {
          const { notes } = getDayState(db, dateOr(url.searchParams.get('date'), cfg));
          const im = notes.images.find((i) => i.id === url.searchParams.get('id'));
          if (!im || !ALLOWED_MIME[im.mime] || !fs.existsSync(im.path)) return send(res, 404, { error: '没有这张图' });
          return send(res, 200, fs.readFileSync(im.path), { 'content-type': im.mime, 'cache-control': 'private, max-age=3600' });
        }
        const key = `${req.method} ${url.pathname}`;
        const handler = api[key];
        if (!handler) return send(res, 404, { error: `没有这个接口：${key}` });
        const body = req.method === 'GET' ? {} : await readBody(req, key === 'POST /api/day/image' ? MAX_IMAGE_BODY : MAX_BODY);
        const out = await handler(url.searchParams, body);
        return send(res, 200, out);
      }
      // 静态文件：只允许 web/ 下的已知文件，防目录穿越
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
      const file = path.resolve(WEB_DIR, rel);
      if (!file.startsWith(WEB_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'not found');
      const ext = path.extname(file).toLowerCase();
      return send(res, 200, fs.readFileSync(file), {
        'content-type': MIME[ext] ?? 'application/octet-stream',
        // 'unsafe-eval' 是 Vue 运行时模板编译需要的；script-src 仍只允许本站脚本，不允许内联和远程
        'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
      });
    } catch (err) {
      const msg = scrubSecrets(err?.message ?? String(err));
      return send(res, 500, { error: msg });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, resolve);
  });
  boundPort = server.address().port;

  // macOS / 新版 Windows 上 `localhost` 常先解析成 ::1；只绑 127.0.0.1 的话用户手敲 localhost 会「拒绝连接」。
  // 再在 ::1 上同端口起一个共享 handler 的监听，失败（机器没 IPv6）就算了。
  let server6 = null;
  if (host === '127.0.0.1') {
    server6 = http.createServer(server.listeners('request')[0]);
    await new Promise((resolve) => {
      server6.once('error', () => {
        server6 = null;
        resolve();
      });
      server6.listen(boundPort, '::1', resolve);
    });
  }

  const url = `http://${host}:${boundPort}/?t=${token}`;
  if (open) openBrowser(url);

  return {
    url,
    port: boundPort,
    token,
    server,
    api,
    close: () =>
      new Promise((resolve) => {
        const done = () => {
          db.close();
          resolve();
        };
        server.close(() => (server6 ? server6.close(done) : done()));
      }),
  };
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try {
    spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* 打不开就让用户手动复制地址 */
  }
}

export { hhmm };
