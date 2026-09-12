import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { aiProblems, aiConfigured, maskConfig, mergeAiConfig, mergeBrowserConfig, dedupeRoots, DEFAULTS } from '../src/config.js';
import { candidateRoots } from '../src/setup.js';
import { applyConfigPatch } from '../src/server/index.js';
import { disclosure } from '../src/ai/write.js';

test('模型服务是否配好只看三样：URL、key、模型名；没有单独的开关', () => {
  assert.deepEqual(aiProblems({}), ['Base URL', 'API Key', '模型名']);
  assert.deepEqual(aiProblems({ baseUrl: 'https://api.deepseek.com', apiKey: 'sk-x', model: '' }), ['模型名']);
  assert.deepEqual(aiProblems({ baseUrl: 'https://api.deepseek.com', apiKey: 'sk-x', model: 'deepseek-chat', enabled: false }), [], '旧的 enabled=false 不再拦人');
  assert.deepEqual(aiProblems({ protocol: 'anthropic', apiKey: 'k', model: 'claude-x' }), [], 'Anthropic 协议可以不填 URL');
  assert.deepEqual(aiProblems({ baseUrl: 'https://api.anthropic.com', apiKey: 'k', model: 'claude-x' }), []);
  assert.deepEqual(aiProblems({ apiKey: 'k', model: 'm' }), ['Base URL'], 'auto 协议没 URL 就是 openai，必须填');
  assert.equal(aiConfigured({ baseUrl: 'u', apiKey: 'k', model: 'm' }), true);
  const masked = maskConfig({ ai: { baseUrl: 'u', apiKey: 'sk-1234567890', model: 'm' } });
  assert.equal(masked.ai.configured, true);
  assert.deepEqual(masked.ai.problems, []);
  assert.match(masked.ai.apiKey, /^\*+7890$/);
  assert.equal(maskConfig({ ai: { model: 'm' } }).ai.configured, false);
});

test('mergeAiConfig 丢掉旧的 enabled 字段；mergeBrowserConfig 只收已知字段', () => {
  const ai = mergeAiConfig({ enabled: false, apiKey: 'old' }, { model: 'm', baseUrl: 'https://x/v1/' });
  assert.equal(ai.enabled, undefined);
  assert.equal(ai.apiKey, 'old');
  assert.equal(ai.baseUrl, 'https://x/v1');
  const b = mergeBrowserConfig(DEFAULTS.browser, { enabled: true, gapMinutes: 3, excludeDomains: [' Bilibili.com ', ''], only: ['Edge'], junk: 1 });
  assert.deepEqual(b, { enabled: true, gapMinutes: 30, excludeDomains: ['bilibili.com'], only: ['edge'] });
  assert.equal(mergeBrowserConfig(undefined, null).enabled, false);
});

test('applyConfigPatch：来源开关、浏览器、目录、setupDone 都能改，未知字段忽略', () => {
  const cfg = { ...DEFAULTS, ai: { ...DEFAULTS.ai }, fileScan: { ...DEFAULTS.fileScan }, sessions: { ...DEFAULTS.sessions }, browser: { ...DEFAULTS.browser }, roots: ['/cwd'], rootsConfigured: false };
  applyConfigPatch(cfg, {
    roots: '/a\n\n /b ',
    fileScan: { outline: false, enabled: true, maxDepth: 99 },
    sessions: { replies: false },
    browser: { enabled: true, excludeDomains: 'x.com\ny.com' },
    setupDone: true,
    authorFilter: ' me@x ',
    gapMinutes: 4,
    cutoffHour: 5,
    excludeProjects: ['secret'],
    bogus: true,
  });
  assert.deepEqual(cfg.roots, ['/a', '/b']);
  assert.equal(cfg.rootsConfigured, true);
  assert.equal(cfg.fileScan.outline, false);
  assert.equal(cfg.fileScan.maxDepth, DEFAULTS.fileScan.maxDepth, '只接受 enabled / outline');
  assert.equal(cfg.sessions.replies, false);
  assert.equal(cfg.browser.enabled, true);
  assert.deepEqual(cfg.browser.excludeDomains, ['x.com', 'y.com']);
  assert.equal(cfg.setupDone, true);
  assert.equal(cfg.authorFilter, 'me@x');
  assert.equal(cfg.gapMinutes, DEFAULTS.gapMinutes, '小于 5 分钟不接受');
  assert.equal(cfg.cutoffHour, 5);
  assert.equal(cfg.bogus, undefined);
  applyConfigPatch(cfg, { roots: [] });
  assert.equal(cfg.rootsConfigured, false, '清空目录 = 退回 cwd');
  assert.equal(cfg.roots.length, 1);
});

test('disclosure 随配置变化：关了回复 / 大纲 / 浏览器就不再声称会发', () => {
  const all = disclosure({ sessions: { replies: true }, fileScan: { outline: true }, browser: { enabled: true } });
  assert.ok(all.includes.some((s) => s.includes('回复')) && all.includes.some((s) => s.includes('大纲')) && all.includes.some((s) => s.includes('网页')));
  const none = disclosure({ sessions: { replies: false }, fileScan: { outline: false }, browser: { enabled: false } });
  assert.ok(!none.includes.some((s) => s.includes('回复')) && !none.includes.some((s) => s.includes('大纲')) && !none.includes.some((s) => s.includes('网页')));
  assert.ok(none.excludes.includes('文件正文'));
});

test('candidateRoots：会话 cwd 的父目录排最前，常见目录只推荐存在的，家目录本身不推荐', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'miztrace-home-'));
  fs.mkdirSync(path.join(home, 'Documents'), { recursive: true });
  fs.mkdirSync(path.join(home, 'Documents', 'codeing', 'proj-a'), { recursive: true });
  fs.mkdirSync(path.join(home, 'Documents', 'codeing', 'proj-b'), { recursive: true });
  fs.mkdirSync(path.join(home, 'code'), { recursive: true });
  const sess = path.join(home, '.claude', 'projects', '-x');
  fs.mkdirSync(sess, { recursive: true });
  const cwdA = path.join(home, 'Documents', 'codeing', 'proj-a');
  const cwdB = path.join(home, 'Documents', 'codeing', 'proj-b');
  fs.writeFileSync(path.join(sess, 's1.jsonl'), `${JSON.stringify({ type: 'user', sessionId: 's1', cwd: cwdA, timestamp: 't', message: { content: 'x' } })}\n`);
  fs.writeFileSync(path.join(sess, 's2.jsonl'), `${JSON.stringify({ type: 'user', sessionId: 's2', cwd: cwdB, timestamp: 't', message: { content: 'x' } })}\n`);
  const codexDir = path.join(home, '.codex', 'sessions', '2026', '09', '09');
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, 'rollout-2026-09-09T10-00-00-019f0396-76f2-7e30-98ef-35bf5f3aa9cc.jsonl'), `${JSON.stringify({ timestamp: 't', type: 'session_meta', payload: { id: 'x', cwd: cwdA } })}\n`);
  const out = candidateRoots({ home, platform: 'darwin', sessionDirs: { 'claude-code': [path.join(home, '.claude', 'projects')], codex: [path.join(home, '.codex', 'sessions')] }, cwd: home });
  assert.equal(out[0].path, path.join(home, 'Documents', 'codeing'), `实际：${JSON.stringify(out)}`);
  assert.equal(out[0].sessions, 3);
  const paths = out.map((c) => c.path);
  assert.ok(paths.includes(path.join(home, 'Documents')) && paths.includes(path.join(home, 'code')));
  assert.ok(!paths.includes(path.resolve(home)), '家目录太大，不推荐');
  assert.ok(!paths.includes(path.join(home, 'Desktop')), '不存在的目录不推荐');
  fs.rmSync(home, { recursive: true, force: true });
});

test('dedupeRoots：嵌套的目录只留外层，重复与空白去掉', () => {
  const a = path.resolve('/tmp/dt-roots/Documents');
  const b = path.resolve('/tmp/dt-roots/Documents/code');
  const c = path.resolve('/tmp/dt-roots/Documents-2');
  assert.deepEqual(dedupeRoots([b, a, ' ', c, a, `${b}/deeper`]), [a, c]);
  assert.deepEqual(dedupeRoots([c, a]), [c, a], '不嵌套的保持原顺序');
  assert.deepEqual(dedupeRoots([]), []);
});

test('日记模板：内置 + 用户改过的按 id 覆盖；跟内置一字不差的不落盘；选错 id 退回第一个', async () => {
  const { templatesOf, pickTemplate, normalizeTemplates, BUILTIN_TEMPLATES } = await import('../src/ai/templates.js');
  assert.equal(templatesOf({}).length, BUILTIN_TEMPLATES.length);
  const cfg = { ai: { template: 'brief', templates: [{ id: 'summary', name: '总结型', text: '我改过的' }, { id: 'mine', name: '我的', text: '三段' }, { id: '', text: '没 id' }] } };
  const all = templatesOf(cfg);
  assert.equal(all.find((t) => t.id === 'summary').text, '我改过的');
  assert.equal(all.find((t) => t.id === 'summary').modified, true);
  assert.equal(all.find((t) => t.id === 'mine').builtin, false);
  assert.equal(all.length, BUILTIN_TEMPLATES.length + 1, '空 id 的丢掉');
  assert.equal(pickTemplate(cfg).id, 'brief');
  assert.equal(pickTemplate(cfg, 'mine').name, '我的');
  assert.equal(pickTemplate(cfg, 'nope').id, BUILTIN_TEMPLATES[0].id);
  const saved = normalizeTemplates([...BUILTIN_TEMPLATES, { id: 'x y!', name: 'n', text: 't' }, { id: 'summary', name: '总结型', text: '改了' }]);
  assert.deepEqual(saved.map((t) => t.id).sort(), ['summary', 'xy'], '内置原样的不存，非法字符从 id 里去掉，同 id 后者为准');
  const merged = mergeAiConfig({}, { template: 'time-line', templates: [{ id: 'mine', name: '我的', text: '三段' }] });
  assert.equal(merged.template, 'time-line');
  assert.deepEqual(merged.templates, [{ id: 'mine', name: '我的', text: '三段' }]);
});

test('applyConfigPatch：终端开关进 shell 段；disclosure 按 shell / browser 开关变化', () => {
  const cfg = { ...JSON.parse(JSON.stringify(DEFAULTS)), roots: ['/x'] };
  applyConfigPatch(cfg, { shell: { enabled: true, file: ' /tmp/x.log ' } });
  assert.equal(cfg.shell.enabled, true);
  assert.equal(cfg.shell.file, '/tmp/x.log');
  applyConfigPatch(cfg, { shell: { file: '' } });
  assert.equal(cfg.shell.file, null);
  assert.equal(cfg.shell.enabled, true, '没传 enabled 就不动');
  assert.ok(disclosure(cfg).includes.some((s) => s.includes('终端')));
  assert.ok(!disclosure({ shell: { enabled: false } }).includes.some((s) => s.includes('终端')));
  assert.ok(disclosure({ browser: { enabled: true } }).includes.some((s) => s.includes('停留时长')));
});
