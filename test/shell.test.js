import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseShellLog, collectShell, isCredentialCommand, hookSnippets, installShellHook, detectShell, HOOK_MARK } from '../src/collect/shell.js';

test('parseShellLog：三列 tab 分隔，坏行跳过，超长命令截断，同一条命令哈希稳定', () => {
  const text = ['2026-09-10T01:02:03Z\t/Users/x/proj\tnpm test', '不是三列', '\t\t', '2026-09-10T01:02:04.000Z\tD:\\wecom\tpowershell   -File  a.ps1', `2026-09-10T01:02:05Z\t/x\t${'a'.repeat(400)}`].join('\n');
  const out = parseShellLog(text);
  assert.equal(out.length, 3);
  assert.equal(out[0].cmd, 'npm test');
  assert.equal(out[1].cmd, 'powershell -File a.ps1', '多余空白压成一个');
  assert.equal(out[1].cwd, 'D:\\wecom');
  assert.equal(out[2].cmd.length, 301);
  assert.equal(parseShellLog(text)[0].id, out[0].id);
});

test('带凭据的命令连本地库都不进', () => {
  assert.equal(isCredentialCommand('mysql -u root -pHunter2 db'), true);
  assert.equal(isCredentialCommand('export OPENAI_API_KEY=sk-abc'), true);
  assert.equal(isCredentialCommand('$env:GITHUB_TOKEN="ghp_x"'), true);
  assert.equal(isCredentialCommand('curl -H "Authorization: Bearer x" https://a'), false, 'Authorization 头不在规则里：宁可放过');
  assert.equal(isCredentialCommand('curl https://user:pass@host/x'), true);
  assert.equal(isCredentialCommand('git push'), false);
  assert.equal(isCredentialCommand('ls -p'), false);
  assert.equal(isCredentialCommand('node bin/miztrace.js today'), false);
});

test('collectShell：只取区间内、去掉凭据命令、按时间排序；文件不存在时 exists=false', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miztrace-shell-'));
  const file = path.join(dir, 'shell.log');
  fs.writeFileSync(
    file,
    ['2026-09-10T02:00:00Z\t/p\tgit pull', '2026-09-10T01:00:00Z\t/p\tnpm install', '2026-09-10T01:30:00Z\t/p\texport TOKEN=abc', '2026-09-09T01:00:00Z\t/p\t昨天的命令', ''].join('\n'),
  );
  const range = { startUtc: '2026-09-10T00:00:00Z', endUtc: '2026-09-11T00:00:00Z' };
  const { commands, stats } = collectShell(range, { file });
  assert.equal(stats.exists, true);
  assert.equal(stats.total, 3);
  assert.equal(stats.skippedCredential, 1);
  assert.deepEqual(commands.map((c) => c.cmd), ['npm install', 'git pull']);
  assert.equal(collectShell(range, { file: path.join(dir, 'none.log') }).stats.exists, false);
});

test('钩子片段：路径按平台拼，Windows 用 PowerShell 的 profile，其它用 zsh / bash', () => {
  const win = hookSnippets('C:\\Users\\x\\AppData\\Roaming\\miztrace\\shell.log', { home: 'C:\\Users\\x', platform: 'win32' });
  assert.deepEqual(win.map((h) => h.id), ['powershell', 'powershell5']);
  assert.equal(win[0].profile, 'C:\\Users\\x\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1');
  assert.match(win[0].snippet, /AddToHistoryHandler/);
  assert.match(win[0].snippet, /'C:\\Users\\x\\AppData\\Roaming\\miztrace\\shell\.log'/);
  const mac = hookSnippets("/Users/x/Library/Application Support/miztrace/shell.log", { home: '/Users/x', platform: 'darwin' });
  assert.deepEqual(mac.map((h) => h.id), ['zsh', 'bash']);
  assert.equal(mac[0].profile, '/Users/x/.zshrc');
  assert.match(mac[0].snippet, /add-zsh-hook preexec/);
  assert.match(mac[0].snippet, /'\/Users\/x\/Library\/Application Support\/miztrace\/shell\.log'/);
  for (const h of [...win, ...mac]) assert.ok(h.snippet.startsWith(HOOK_MARK));
});

test('installShellHook：只追加到存在的配置文件，装过不再装；detectShell 能看出装没装', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'miztrace-home-'));
  fs.writeFileSync(path.join(home, '.zshrc'), 'export FOO=1'); // 没有换行结尾
  const cfg = { shell: { enabled: false, file: path.join(home, 'shell.log') } };
  const opts = { home, platform: 'darwin' };
  const r1 = installShellHook(cfg, [], opts);
  assert.deepEqual(r1.map((r) => [r.id, r.status]), [['zsh', 'installed']], 'bash 的配置文件不存在，不创建');
  const rc = fs.readFileSync(path.join(home, '.zshrc'), 'utf8');
  assert.ok(rc.startsWith('export FOO=1\n\n'), '原内容不动，换行后再追加');
  assert.ok(rc.includes(HOOK_MARK));
  const r2 = installShellHook(cfg, [], opts);
  assert.deepEqual(r2.map((r) => r.status), ['already']);
  assert.equal(fs.readFileSync(path.join(home, '.zshrc'), 'utf8'), rc, '第二次不重复追加');
  const st = detectShell(cfg, opts);
  assert.equal(st.shells.find((h) => h.id === 'zsh').installed, true);
  assert.equal(st.shells.find((h) => h.id === 'bash').installed, false);
  assert.equal(st.exists, false);
});
