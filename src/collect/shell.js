/**
 * 终端命令采集（ADR-023）。默认关闭。
 *
 * 为什么不直接读 shell 自带的历史文件：
 *   - PowerShell（PSReadLine）的 ConsoleHost_history.txt 不记时间，cmd 根本不存历史；
 *   - zsh 只有开了 EXTENDED_HISTORY 才带时间，bash 要设 HISTTIMEFORMAT；
 *   没有时间就排不进时间板，也分不清是今天敲的还是上个月敲的。
 * 所以走钩子：在 shell 配置里加几行，每条命令连时间、目录一起追加到 MizTrace 自己的日志里。
 * 用户要自己装（`miztrace shell-hook --install` 或网页设置里一键），装了才有数据。
 *
 * 日志格式：每行 `<ISO 时间>\t<目录>\t<命令>`，UTF-8。只记敲下的命令本身，不记输出。
 * 采集时跳过明显带凭据的命令（password= / token= / export XXX_KEY=…），这类连本地库都不进。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir } from '../config.js';

export const HOOK_MARK = '# MizTrace shell hook';
/** 改名前装的钩子带的是这个标记：照样算「已装」，别给用户装第二份。 */
export const LEGACY_HOOK_MARK = '# DayTrace shell hook';
const MAX_COMMAND = 300;
/** 单次读多少字节：日志按天追加，一年也就几 MB；只读尾部 8 MB 足够覆盖任何一天。 */
const TAIL_BYTES = 8 * 1024 * 1024;

/** 带凭据的命令：整条不记。宁可漏记一条 curl，也不能把 token 写进日记库。 */
const CREDENTIAL_PATTERNS = [
  /(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)\s*[=:]\s*\S/i,
  /\b(?:export|set|setx|\$env:)\s*\w*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)\w*\s*[=:]/i,
  /--(?:password|token|api-key|secret)(?:[=\s]+)\S/i,
  /(?:^|\s)-p\S{4,}/, // mysql -pxxxx
  /https?:\/\/[^\s/@]+:[^\s/@]+@/i, // 地址里带 user:pass@
  /\b(?:sk|ghp|gho|xox[abp]|AKIA)[A-Za-z0-9_-]{16,}/,
];

export function shellLogPath(cfg) {
  return cfg?.shell?.file ? String(cfg.shell.file) : path.join(dataDir(), 'shell.log');
}

export function isCredentialCommand(cmd) {
  return CREDENTIAL_PATTERNS.some((re) => re.test(cmd));
}

/**
 * 解析日志文本 → 命令列表。坏行跳过，不抛。
 * @returns {{ts:string,cwd:string,cmd:string,id:string}[]}
 */
export function parseShellLog(text) {
  const out = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const i = line.indexOf('\t');
    const j = i < 0 ? -1 : line.indexOf('\t', i + 1);
    if (i < 0 || j < 0) continue;
    const tsRaw = line.slice(0, i).trim();
    const cwd = line.slice(i + 1, j).trim();
    let cmd = line.slice(j + 1).replace(/\s+/g, ' ').trim();
    if (!cmd) continue;
    const ms = Date.parse(tsRaw);
    if (!Number.isFinite(ms)) continue;
    if (cmd.length > MAX_COMMAND) cmd = `${cmd.slice(0, MAX_COMMAND)}…`;
    const ts = new Date(ms).toISOString();
    const id = crypto.createHash('sha1').update(`${ts}\t${cwd}\t${cmd}`).digest('hex').slice(0, 16);
    out.push({ ts, cwd, cmd, id });
  }
  return out;
}

/**
 * 读区间内的终端命令。
 * @param {{startUtc:string,endUtc:string}} range
 * @param {{file:string}} opts
 * @returns {{commands:{ts:string,cwd:string,cmd:string,id:string}[], stats:{total:number, skippedCredential:number, exists:boolean}}}
 */
export function collectShell(range, opts) {
  const file = opts.file;
  const stats = { total: 0, skippedCredential: 0, exists: false };
  let text = '';
  try {
    const st = fs.statSync(file);
    stats.exists = true;
    const fd = fs.openSync(file, 'r');
    try {
      const size = st.size;
      const start = Math.max(0, size - TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
      if (start > 0) text = text.slice(text.indexOf('\n') + 1); // 掐掉可能被截断的第一行
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { commands: [], stats };
  }
  const startMs = Date.parse(range.startUtc);
  const endMs = Date.parse(range.endUtc);
  const commands = [];
  const seen = new Set();
  for (const c of parseShellLog(text)) {
    const ms = Date.parse(c.ts);
    if (ms < startMs || ms >= endMs) continue;
    stats.total += 1;
    if (isCredentialCommand(c.cmd)) {
      stats.skippedCredential += 1;
      continue;
    }
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    commands.push(c);
  }
  commands.sort((a, b) => a.ts.localeCompare(b.ts));
  return { commands, stats };
}

/** 路径写进 shell 脚本：单引号里只需转义单引号本身。 */
const sq = (p) => `'${String(p).replace(/'/g, "'\\''")}'`;
const psq = (p) => `'${String(p).replace(/'/g, "''")}'`;

/**
 * 各 shell 的钩子片段。路径是算好的绝对路径（跟 MIZTRACE_DATA_DIR 一致），用户不用改。
 * @param {string} logFile
 * @returns {{id:string,name:string,profile:string,snippet:string}[]}
 */
export function hookSnippets(logFile, opts = {}) {
  const home = opts.home ?? os.homedir();
  const platform = opts.platform ?? process.platform;
  const P = platform === 'win32' ? path.win32 : path.posix;
  const dir = P.dirname(logFile);
  const out = [];
  if (platform === 'win32') {
    const snippet = [
      HOOK_MARK,
      `$script:MizTraceLog = ${psq(logFile)}`,
      `if (-not (Test-Path (Split-Path $script:MizTraceLog))) { New-Item -ItemType Directory -Force -Path (Split-Path $script:MizTraceLog) | Out-Null }`,
      `if (Get-Module -Name PSReadLine) { Set-PSReadLineOption -AddToHistoryHandler {`,
      `  param($line)`,
      `  $cmd = ($line -replace "[\`t\`r\`n]+", " ").Trim()`,
      `  if ($cmd) { Add-Content -Path $script:MizTraceLog -Encoding utf8 -Value ((Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ") + "\`t" + $PWD.Path + "\`t" + $cmd) }`,
      `  return $true`,
      `} }`,
      `# MizTrace shell hook end`,
    ].join('\n');
    out.push({ id: 'powershell', name: 'PowerShell 7', profile: P.join(home, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1'), snippet });
    out.push({ id: 'powershell5', name: 'Windows PowerShell 5', profile: P.join(home, 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'), snippet });
    return out;
  }
  const zsh = [
    HOOK_MARK,
    `_miztrace_log() { local c="\${1//$'\\t'/ }"; c="\${c//$'\\n'/ }"; [ -n "$c" ] && { mkdir -p ${sq(dir)}; printf '%s\\t%s\\t%s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$PWD" "$c" >> ${sq(logFile)}; }; }`,
    `autoload -Uz add-zsh-hook && add-zsh-hook preexec _miztrace_log`,
    `# MizTrace shell hook end`,
  ].join('\n');
  const bash = [
    HOOK_MARK,
    `_miztrace_log() { local c; c="$(HISTTIMEFORMAT= history 1 | sed 's/^ *[0-9]* *//')"; [ -n "$c" ] && [ "$c" != "$_MIZTRACE_LAST" ] && { _MIZTRACE_LAST="$c"; mkdir -p ${sq(dir)}; printf '%s\\t%s\\t%s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$PWD" "$c" >> ${sq(logFile)}; }; }`,
    `PROMPT_COMMAND="_miztrace_log\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"`,
    `# MizTrace shell hook end`,
  ].join('\n');
  out.push({ id: 'zsh', name: 'zsh', profile: P.join(home, '.zshrc'), snippet: zsh });
  out.push({ id: 'bash', name: 'bash', profile: P.join(home, platform === 'darwin' ? '.bash_profile' : '.bashrc'), snippet: bash });
  return out;
}

function fileHas(file, needle) {
  try {
    return fs.readFileSync(file, 'utf8').includes(needle);
  } catch {
    return false;
  }
}

/**
 * 本机终端记录的状态：日志在哪、有没有、各 shell 的钩子装没装。给 `miztrace sources` 与网页设置用。
 */
export function detectShell(cfg, opts = {}) {
  const file = shellLogPath(cfg);
  let lines = 0;
  let exists = false;
  try {
    const st = fs.statSync(file);
    exists = true;
    lines = st.size ? parseShellLog(fs.readFileSync(file, 'utf8')).length : 0;
  } catch {
    exists = false;
  }
  const shells = hookSnippets(file, opts).map((h) => ({ ...h, profileExists: fs.existsSync(h.profile), installed: fileHas(h.profile, HOOK_MARK) || fileHas(h.profile, LEGACY_HOOK_MARK) }));
  return { enabled: cfg?.shell?.enabled === true, file, exists, lines, shells };
}

/**
 * 把钩子写进 shell 配置文件（已装过就跳过）。只追加，不改用户原有内容。
 * @param {string[]} [ids] 只装这些 shell；空 = 该平台的全部
 * @returns {{id:string,profile:string,status:'installed'|'already'|'failed',error?:string}[]}
 */
export function installShellHook(cfg, ids = [], opts = {}) {
  const file = shellLogPath(cfg);
  const results = [];
  for (const h of hookSnippets(file, opts)) {
    if (ids.length && !ids.includes(h.id)) continue;
    if (fileHas(h.profile, HOOK_MARK) || fileHas(h.profile, LEGACY_HOOK_MARK)) {
      results.push({ id: h.id, profile: h.profile, status: 'already' });
      continue;
    }
    // 只给「存在的」配置文件追加；PowerShell 例外 —— 它的 profile 默认不存在，得替用户建
    if (!fs.existsSync(h.profile) && !h.id.startsWith('powershell')) continue;
    try {
      fs.mkdirSync(path.dirname(h.profile), { recursive: true });
      const cur = fs.existsSync(h.profile) ? fs.readFileSync(h.profile, 'utf8') : '';
      const sep = cur && !cur.endsWith('\n') ? '\n\n' : cur ? '\n' : '';
      fs.appendFileSync(h.profile, `${sep}${h.snippet}\n`, 'utf8');
      results.push({ id: h.id, profile: h.profile, status: 'installed' });
    } catch (err) {
      results.push({ id: h.id, profile: h.profile, status: 'failed', error: err.message });
    }
  }
  return results;
}
