/**
 * 配置与跨平台数据目录（ADR-011）。
 * macOS  ~/Library/Application Support/miztrace
 * Windows %APPDATA%\miztrace
 * 其他    $XDG_DATA_HOME/miztrace 或 ~/.local/share/miztrace
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DEFAULT_CUTOFF_HOUR } from './time.js';
import { normalizeTemplates } from './ai/templates.js';

/** SQLite WAL 放在这些同步目录里有损坏风险，检测到就告警。 */
const SYNC_DIR_HINTS = ['iCloud', 'OneDrive', 'Dropbox', 'Google Drive', 'Nextcloud', '坚果云'];

/**
 * 数据目录。项目从 DayTrace 改名 MizTrace 之后目录名也改了；老用户机器上已有 daytrace 目录、
 * 新目录还不存在时继续用老的，数据一点不丢。环境变量也两个都认（新的优先）。
 */
export function dataDir() {
  if (process.env.MIZTRACE_DATA_DIR) return process.env.MIZTRACE_DATA_DIR;
  if (process.env.DAYTRACE_DATA_DIR) return process.env.DAYTRACE_DATA_DIR;
  const home = os.homedir();
  const base =
    process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : process.platform === 'win32' ? process.env.APPDATA || path.join(home, 'AppData', 'Roaming') : process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  const fresh = path.join(base, 'miztrace');
  const legacy = path.join(base, 'daytrace');
  if (!fs.existsSync(fresh) && fs.existsSync(legacy)) return legacy;
  return fresh;
}

export function dbPath() {
  return path.join(dataDir(), 'miztrace.db');
}

export function configPath() {
  return path.join(dataDir(), 'config.json');
}

/**
 * 默认的会话目录，跨平台展开。专用适配器的目录是实测 / 文档里的；通用适配器（没拿到样例的工具）
 * 只填最可能的家目录，不存在就当没装，不会误报。
 */
export function defaultSessionDirs(opts = {}) {
  const home = opts.home ?? os.homedir();
  const platform = opts.platform ?? process.platform;
  // 按目标平台拼路径：传了 platform 就该给出那个平台的写法，不能跟着运行测试的机器走（Windows 上跑 darwin 用例会拼出反斜杠）
  const P = platform === 'win32' ? path.win32 : path.posix;
  const env = opts.env ?? process.env;
  const appData = env.APPDATA || P.join(home, 'AppData', 'Roaming');
  const localAppData = env.LOCALAPPDATA || P.join(home, 'AppData', 'Local');
  const xdgData = env.XDG_DATA_HOME || P.join(home, '.local', 'share');
  const xdgConfig = env.XDG_CONFIG_HOME || P.join(home, '.config');
  /** VS Code 系编辑器的 User 目录（插件数据在 User/globalStorage/<插件 id>）。 */
  const userDir = (app) => (platform === 'darwin' ? P.join(home, 'Library', 'Application Support', app, 'User') : platform === 'win32' ? P.join(appData, app, 'User') : P.join(xdgConfig, app, 'User'));
  const ext = (extId) => ['Code', 'Code - Insiders', 'VSCodium', 'Cursor', 'Windsurf', 'Trae'].map((app) => P.join(userDir(app), 'globalStorage', extId));
  const dotAndApp = (dot, app) => [P.join(home, dot), ...(platform === 'win32' ? [P.join(appData, app), P.join(localAppData, app)] : [P.join(xdgData, app), P.join(xdgConfig, app)])];
  /** 桌面应用的数据目录：macOS 在 Application Support，Windows 在 AppData 的 Roaming / Local，Linux 按 XDG。 */
  const appDir = (app) => (platform === 'darwin' ? [P.join(home, 'Library', 'Application Support', app)] : platform === 'win32' ? [P.join(appData, app), P.join(localAppData, app)] : [P.join(xdgData, app.toLowerCase()), P.join(xdgConfig, app.toLowerCase())]);
  return {
    'claude-code': [P.join(home, '.claude', 'projects')],
    codex: [P.join(home, '.codex', 'sessions'), P.join(home, '.codex', 'archived_sessions')],
    'gemini-cli': [P.join(home, '.gemini')],
    'qwen-code': [P.join(home, '.qwen')],
    iflow: [P.join(home, '.iflow')],
    // opencode：Linux / macOS 在 XDG 数据目录；Windows 上它自己也用 ~/.local/share，再兜一下 AppData
    opencode: [P.join(xdgData, 'opencode'), ...(platform === 'win32' ? [P.join(home, '.local', 'share', 'opencode'), P.join(localAppData, 'opencode'), P.join(appData, 'opencode')] : [])],
    // Hermes Agent（Nous Research）：状态目录 ~/.hermes（state.db + 各种 JSON）；没拿到样例
    hermes: [P.join(home, '.hermes')],
    cursor: [userDir('Cursor')],
    cline: ext('saoudrizwan.claude-dev'),
    'roo-code': ext('rooveterinaryinc.roo-cline'),
    'kilo-code': ext('kilocode.kilo-code'),
    zcode: [P.join(home, '.zcode')],
    'copilot-chat': [userDir('Code'), userDir('Code - Insiders'), userDir('VSCodium')],
    // Antigravity（Google 的 IDE）：实测 macOS 上 IDE 数据在 Application Support/Antigravity IDE，agent 对话目录在 ~/.gemini/antigravity-ide
    antigravity: [userDir('Antigravity IDE'), userDir('Antigravity'), P.join(home, '.gemini', 'antigravity-ide', 'conversations'), P.join(home, '.gemini', 'antigravity', 'conversations')],
    trae: [userDir('Trae'), userDir('TRAE SOLO'), userDir('Trae CN')],
    windsurf: [userDir('Windsurf'), P.join(home, '.codeium', 'windsurf')],
    'kimi-code': dotAndApp('.kimi', 'kimi'),
    deepseek: dotAndApp('.deepseek', 'deepseek'),
    'grok-build': [P.join(home, '.grok'), P.join(home, '.grokbuild'), P.join(home, '.grok-build')],
    'copilot-cli': [P.join(home, '.copilot')],
    codebuddy: [P.join(home, '.codebuddy')],
    // 腾讯 WorkBuddy（CodeBuddy 团队的桌面版工作助手，Windows / macOS）：没拿到样例，只知道桌面应用大概会放在这几处；
    // 不在这些目录的话，把实际目录填进 config.json 的 sessionDirs.workbuddy
    workbuddy: [P.join(home, '.workbuddy'), ...appDir('WorkBuddy'), ...appDir(P.join('Tencent', 'WorkBuddy'))],
    goose: [P.join(xdgData, 'goose', 'sessions'), P.join(home, '.config', 'goose', 'sessions')],
    crush: [P.join(xdgData, 'crush'), P.join(home, '.crush')],
  };
}

export const DEFAULTS = {
  cutoffHour: DEFAULT_CUTOFF_HOUR,
  /** IANA 时区名。null = 用本机时区（推荐）。填了就固定用这个时区跑。 */
  timezone: null,
  /** 要扫描 git 仓库的根目录，留空则用 cwd。 */
  roots: [],
  /** 只统计这个 author 的 commit（email 或 name 片段），null = 全部。 */
  authorFilter: null,
  /** 生成的 Markdown 写到哪里，null = 只打印。 */
  out: null,
  sessionDirs: null,
  /** true 时永久禁用一切外发（ADR-008 §8.4）。 */
  managedDevice: false,
  /** 网页首次打开时的引导（选目录、选来源）是否已经做过。 */
  setupDone: false,
  /** 文件系统扫描（ADR-019）。只记路径与时间；outline 打开时另读文档的标题层级 / 工作表名（ADR-022）。 */
  fileScan: {
    enabled: true,
    maxDepth: 6,
    maxFiles: 5000,
    extraExcludes: [],
    /** 'worklike' = 只记像工作产物的文件（推荐）；'all' = 记下所有非敏感文件 */
    mode: 'worklike',
    /** 额外算作工作产物的扩展名，如 ["dwg","step"] */
    extraExtensions: [],
    /** 读文档大纲：docx 标题层级、xlsx 工作表名、pptx 每页标题、md 标题。只读结构，不读正文。 */
    outline: true,
  },
  /** AI 会话采集。replies = 除了你的提问，也记下 AI 工具每一轮的最终回复（截前 300 字），用来知道它实际做了什么。 */
  sessions: {
    replies: true,
  },
  /**
   * 浏览器历史（ADR-022）。默认关闭；网页引导里检测到浏览器时可勾选打开。
   * 只记页面标题、去掉参数的地址、时间与搜索词，不读页面内容；按 gapMinutes 切成一段段浏览。
   */
  browser: {
    enabled: false,
    gapMinutes: 30,
    /** 不记这些域名（子串匹配），例如 ["bilibili.com"] */
    excludeDomains: [],
    /** 只读这些浏览器（chrome / edge / brave / chromium / arc / firefox / safari）；空 = 检测到的全部 */
    only: [],
  },
  /** 同一项目内间隔超过这么多分钟算两段工作（模块切块阈值）。 */
  gapMinutes: 90,
  /**
   * 终端命令（ADR-023）。默认关闭。开了也只读 MizTrace 自己的钩子日志（miztrace shell-hook --install 装钩子），
   * 只记命令本身与所在目录，不记输出；带凭据的命令连本地库都不进。file 可指定日志位置，null = 数据目录下的 shell.log。
   */
  shell: {
    enabled: false,
    file: null,
  },
  /** 永久排除的项目：rootPath 子串或项目名。前端「永久排除」写到这里。 */
  excludeProjects: [],
  /**
   * AI 写作。填齐 baseUrl / apiKey / model 即可用，没有单独的开关 —— 每次发送前都有确认弹窗。
   * protocol: 'auto' | 'openai' | 'anthropic'。auto 按 URL 里是否含 anthropic 判断。
   * baseUrl 填到 /v1 为止（OpenAI 兼容），或只填域名（Anthropic）。
   */
  ai: {
    protocol: 'auto',
    baseUrl: '',
    apiKey: '',
    model: '',
    /** 两层日记（概览 + 过程）用中文写，2000 tokens 常常不够写完就被截断；推理模型还要算上思考。 */
    maxTokens: 4000,
    temperature: 0.4,
    timeoutMs: 60_000,
    /** 每日调用上限（次），防手滑；0 = 不限。 */
    dailyLimit: 30,
    /** 整篇日记的写作要求（可选），每次生成都带给模型；某个模块单独的要求在网页抽屉里写。 */
    style: '',
    /** 模型能看图：开了以后，你在「手记」里传的图片会作为原图一起发给模型（OpenAI 的 image_url / Anthropic 的 image 块）。 */
    vision: false,
    /** 用哪个日记模板（内置：summary / timeline / review / brief，或自定义的 id）。 */
    template: 'summary',
    /** 用户改过或新加的模板 [{id,name,text}]；跟内置一样的不存。 */
    templates: [],
  },
  ui: { port: 0 },
};

/**
 * 模型服务还缺什么。空数组 = 配置完整、可以发送。
 * 曾经有一个独立的 ai.enabled 开关：用户填齐了 URL / key / 模型名、测试也通了，
 * 却因为没勾那个框被告知「还没配置模型服务」—— 开关本身就是 bug，已删除。
 * @returns {string[]}
 */
export function aiProblems(ai) {
  const a = ai ?? {};
  const problems = [];
  const model = String(a.model ?? '').trim();
  const baseUrl = String(a.baseUrl ?? '').trim();
  const proto = a.protocol && a.protocol !== 'auto' ? a.protocol : /anthropic/i.test(baseUrl) ? 'anthropic' : 'openai';
  if (!baseUrl && proto === 'openai') problems.push('Base URL');
  if (!String(a.apiKey ?? '').trim()) problems.push('API Key');
  if (!model) problems.push('模型名');
  return problems;
}

export function aiConfigured(ai) {
  return aiProblems(ai).length === 0;
}

/** 在 API / 日志里展示配置时用：apiKey 只留后 4 位。 */
export function maskConfig(cfg) {
  const out = JSON.parse(JSON.stringify(cfg));
  if (out.ai?.apiKey) {
    const k = String(out.ai.apiKey);
    out.ai.apiKey = k.length > 4 ? `${'*'.repeat(Math.min(12, k.length - 4))}${k.slice(-4)}` : '****';
    out.ai.hasApiKey = true;
  } else if (out.ai) {
    out.ai.apiKey = '';
    out.ai.hasApiKey = false;
  }
  if (out.ai) {
    out.ai.configured = aiConfigured(cfg.ai);
    out.ai.problems = aiProblems(cfg.ai);
  }
  return out;
}

/** 合并前端提交的 ai 配置：apiKey 为空或是掩码时保留旧值，避免一次保存把 key 抹掉。 */
export function mergeAiConfig(current, incoming) {
  const next = { ...DEFAULTS.ai, ...(current ?? {}) };
  delete next.enabled; // 旧字段，已无语义
  if (!incoming || typeof incoming !== 'object') return next;
  for (const k of ['protocol', 'baseUrl', 'model', 'maxTokens', 'temperature', 'timeoutMs', 'dailyLimit', 'style', 'template']) {
    if (incoming[k] !== undefined) next[k] = incoming[k];
  }
  if (Array.isArray(incoming.templates)) next.templates = normalizeTemplates(incoming.templates);
  if (typeof incoming.vision === 'boolean') next.vision = incoming.vision;
  next.template = String(next.template ?? 'summary').trim().replace(/[^\w-]/g, '') || 'summary';
  if (!Array.isArray(next.templates)) next.templates = [];
  if (typeof incoming.apiKey === 'string' && incoming.apiKey && !/^\*+/.test(incoming.apiKey)) next.apiKey = incoming.apiKey.trim();
  if (incoming.clearApiKey === true) next.apiKey = '';
  next.baseUrl = String(next.baseUrl ?? '').trim().replace(/\/+$/, '');
  next.model = String(next.model ?? '').trim();
  next.style = String(next.style ?? '').trim().slice(0, 2000);
  next.maxTokens = Math.max(200, Math.min(32_000, Number(next.maxTokens) || 4000));
  next.temperature = Math.max(0, Math.min(2, Number(next.temperature) || 0));
  return next;
}

/** 合并前端提交的终端配置。 */
export function mergeShellConfig(current, incoming) {
  const next = { ...DEFAULTS.shell, ...(current ?? {}) };
  if (!incoming || typeof incoming !== 'object') return next;
  if (typeof incoming.enabled === 'boolean') next.enabled = incoming.enabled;
  if (typeof incoming.file === 'string') next.file = incoming.file.trim() || null;
  return next;
}

/** 合并前端提交的浏览器配置。 */
export function mergeBrowserConfig(current, incoming) {
  const next = { ...DEFAULTS.browser, ...(current ?? {}) };
  if (!incoming || typeof incoming !== 'object') return next;
  if (typeof incoming.enabled === 'boolean') next.enabled = incoming.enabled;
  if (Number.isInteger(incoming.gapMinutes) && incoming.gapMinutes >= 5) next.gapMinutes = incoming.gapMinutes;
  if (Array.isArray(incoming.excludeDomains)) next.excludeDomains = incoming.excludeDomains.map((d) => String(d).trim().toLowerCase()).filter(Boolean);
  if (Array.isArray(incoming.only)) next.only = incoming.only.map((d) => String(d).trim().toLowerCase()).filter(Boolean);
  return next;
}

/**
 * 去掉嵌套的扫描目录：同时选了 ~/Documents 和 ~/Documents/code，后者已经在前者里面，
 * 留着只会让同一个文件被扫两遍、模块里出现两条一样的改动。也顺手去重、去空。
 */
export function dedupeRoots(roots) {
  const resolved = [...new Set((roots ?? []).map((r) => String(r ?? '').trim()).filter(Boolean).map((r) => path.resolve(r)))];
  return resolved.filter((r) => !resolved.some((other) => other !== r && (r === other || r.startsWith(other + path.sep))));
}

export function ensureDataDir() {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function loadConfig() {
  const file = configPath();
  let onDisk = {};
  if (fs.existsSync(file)) {
    try {
      onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`配置文件解析失败：${file}\n${err.message}`);
    }
  }
  const cfg = { ...DEFAULTS, ...onDisk };
  cfg.sessionDirs = { ...defaultSessionDirs(), ...(onDisk.sessionDirs || {}) };
  cfg.ai = { ...DEFAULTS.ai, ...(onDisk.ai || {}) };
  delete cfg.ai.enabled;
  // 2000 是老版本写进配置文件的默认值，中文两层日记经常写不完就被截断；带思考的模型更是一个字都出不来。抬到新默认。
  if (cfg.ai.maxTokens === 2000) cfg.ai.maxTokens = DEFAULTS.ai.maxTokens;
  cfg.fileScan = { ...DEFAULTS.fileScan, ...(onDisk.fileScan || {}) };
  cfg.sessions = { ...DEFAULTS.sessions, ...(onDisk.sessions || {}) };
  cfg.browser = { ...DEFAULTS.browser, ...(onDisk.browser || {}) };
  cfg.shell = { ...DEFAULTS.shell, ...(onDisk.shell || {}) };
  if (!Array.isArray(cfg.ai.templates)) cfg.ai.templates = [];
  cfg.ui = { ...DEFAULTS.ui, ...(onDisk.ui || {}) };
  if (!Array.isArray(cfg.excludeProjects)) cfg.excludeProjects = [];
  if (!Number.isInteger(cfg.gapMinutes) || cfg.gapMinutes < 5) cfg.gapMinutes = DEFAULTS.gapMinutes;
  // 记住 roots 是用户配的还是退回到了 cwd：网页要据此决定要不要弹首次引导
  cfg.rootsConfigured = Array.isArray(onDisk.roots) && onDisk.roots.length > 0;
  cfg.roots = Array.isArray(cfg.roots) ? dedupeRoots(cfg.roots) : [];
  if (cfg.roots.length === 0) cfg.roots = [process.cwd()];
  if (!Number.isInteger(cfg.cutoffHour) || cfg.cutoffHour < 0 || cfg.cutoffHour > 23) {
    cfg.cutoffHour = DEFAULT_CUTOFF_HOUR;
  }
  return cfg;
}

export function saveConfig(cfg) {
  ensureDataDir();
  const toSave = { ...cfg };
  delete toSave.effectiveTimezone; // 运行时派生值，不落盘
  delete toSave.rootsConfigured;
  if (toSave.ai) {
    toSave.ai = { ...toSave.ai };
    delete toSave.ai.enabled;
  }
  // 里面有 API key：POSIX 下收紧为仅本人可读写；Windows 走 ACL，chmod 不生效也不报错
  fs.writeFileSync(configPath(), `${JSON.stringify(toSave, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    if (process.platform !== 'win32') fs.chmodSync(configPath(), 0o600);
  } catch {
    /* 忽略 */
  }
  return configPath();
}

/** 数据目录是否位于云同步目录内。 */
export function syncDirWarning(dir = dataDir()) {
  const hit = SYNC_DIR_HINTS.find((h) => dir.toLowerCase().includes(h.toLowerCase()));
  if (!hit) return null;
  return `数据目录位于「${hit}」同步目录内：${dir}\nSQLite WAL 在同步目录下有损坏风险，建议用 MIZTRACE_DATA_DIR 指到本地目录。`;
}
