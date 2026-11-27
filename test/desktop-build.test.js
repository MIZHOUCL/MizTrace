import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyBuildOutput } from '../desktop/build-output.mjs';

test('构建产物复制后保留普通安装包内容', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miztrace-build-copy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'temporary');
  const target = path.join(root, 'release');
  fs.mkdirSync(path.join(source, 'make'), { recursive: true });
  fs.writeFileSync(path.join(source, 'make', 'installer.exe'), 'installer fixture');
  copyBuildOutput(source, target);
  fs.rmSync(source, { recursive: true });
  assert.equal(fs.readFileSync(path.join(target, 'make', 'installer.exe'), 'utf8'), 'installer fixture');
});

test('Mac App 复制并清理临时目录后，Framework 多层相对链接仍可访问', { skip: process.platform === 'win32' ? 'Windows 创建符号链接需要额外权限；在 macOS CI 验证' : false }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miztrace-framework-copy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'temporary');
  const target = path.join(root, 'release');
  const framework = path.join('MizTrace.app', 'Contents', 'Frameworks', 'Electron Framework.framework');
  const original = path.join(source, framework);
  fs.mkdirSync(path.join(original, 'Versions', 'A', 'Resources'), { recursive: true });
  fs.writeFileSync(path.join(original, 'Versions', 'A', 'Electron Framework'), 'runtime fixture', { mode: 0o755 });
  fs.writeFileSync(path.join(original, 'Versions', 'A', 'Resources', 'Info.plist'), 'resources fixture');
  fs.symlinkSync('A', path.join(original, 'Versions', 'Current'), 'dir');
  fs.symlinkSync('Versions/Current/Electron Framework', path.join(original, 'Electron Framework'), 'file');
  fs.symlinkSync('Versions/Current/Resources', path.join(original, 'Resources'), 'dir');

  copyBuildOutput(source, target);
  fs.rmSync(source, { recursive: true });

  const copied = path.join(target, framework);
  assert.equal(fs.readlinkSync(path.join(copied, 'Versions', 'Current')), 'A');
  assert.equal(fs.readlinkSync(path.join(copied, 'Electron Framework')), 'Versions/Current/Electron Framework');
  assert.equal(fs.readFileSync(path.join(copied, 'Electron Framework'), 'utf8'), 'runtime fixture');
  assert.equal(fs.readFileSync(path.join(copied, 'Resources', 'Info.plist'), 'utf8'), 'resources fixture');
  assert.ok(fs.statSync(path.join(copied, 'Electron Framework')).mode & 0o111);
});
