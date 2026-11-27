import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MAX_JOURNAL_BYTES = 512 * 1024;
export const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
export function journalError(message, status = 400, code = 'INVALID_DOCUMENT') {
  return Object.assign(new Error(message), { status, code });
}

export function journalRoot(cfg) {
  if (!cfg.out || !fs.existsSync(cfg.out)) return null;
  const root = fs.realpathSync(cfg.out);
  if (!fs.statSync(root).isDirectory()) throw journalError('日记目录不是文件夹');
  return root;
}

/** 不接受绝对路径、反斜杠、ADS 或目录中的符号链接 / junction。 */
export function checkedJournalPath(root, relative, { missing = false } = {}) {
  if (typeof relative !== 'string' || !relative || /[\\:\x00]/.test(relative) || path.isAbsolute(relative) ||
      relative.split('/').some((p) => !p || p === '.' || p === '..') || !/\.md$/i.test(relative)) {
    throw journalError('日记路径无效');
  }
  const parts = relative.split('/');
  let file = root;
  for (let i = 0; i < parts.length; i++) {
    file = path.join(file, parts[i]);
    let stat;
    try { stat = fs.lstatSync(file); } catch (e) {
      if (missing && i === parts.length - 1 && e.code === 'ENOENT') return file;
      if (e.code === 'ENOENT') throw journalError('文件已被移动或删除，请刷新列表', 404, 'NOT_FOUND');
      throw e;
    }
    if (stat.isSymbolicLink() || (i < parts.length - 1 && !stat.isDirectory()) ||
        (i === parts.length - 1 && !stat.isFile())) throw journalError('不读取或修改符号链接和特殊文件');
  }
  return file;
}

export function readJournalFile(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_JOURNAL_BYTES) throw journalError('仅支持不超过 512 KiB 的 Markdown 文件', 413, 'TOO_LARGE');
    const bytes = Buffer.alloc(MAX_JOURNAL_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const n = fs.readSync(fd, bytes, length, bytes.length - length, null);
      if (!n) break;
      length += n;
    }
    if (length > MAX_JOURNAL_BYTES) throw journalError('文件超过 512 KiB', 413, 'TOO_LARGE');
    let markdown;
    try { markdown = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)); }
    catch { throw journalError('文件不是 UTF-8 编码，请先转换后再编辑'); }
    return { markdown, revision: digest(bytes.subarray(0, length)) + ':' + stat.mtimeMs + ':' + stat.ctimeMs, updatedAt: stat.mtime.toISOString(), bytes: length };
  } finally { fs.closeSync(fd); }
}

/** 同目录临时文件 + rename，写失败不会截断原文件；另存一份原始字节备份。 */
export function replaceJournalFile(file, markdown, expectedRevision) {
  const current = fs.existsSync(file) ? readJournalFile(file) : null;
  if ((current?.revision ?? null) !== expectedRevision) throw journalError('文件已被其他窗口或编辑器修改，请重新打开后合并', 409, 'REVISION_CONFLICT');
  if (current?.markdown === markdown) return;
  const temp = path.join(path.dirname(file), `.miztrace-${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, markdown, { flag: 'wx', mode: 0o600 });
    if (current) {
      const latest = readJournalFile(file);
      if (latest.revision !== expectedRevision) throw journalError('保存前文件发生变化，请重新打开后合并', 409, 'REVISION_CONFLICT');
      fs.copyFileSync(file, `${file}.${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}.bak`, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(temp, fs.statSync(file).mode);
      fs.renameSync(temp, file);
    } else {
      // 排他创建；另一进程抢先创建目标时不会覆盖它，也支持无硬链接的文件系统。
      try { fs.copyFileSync(temp, file, fs.constants.COPYFILE_EXCL); }
      catch (e) { if (e.code === 'EEXIST') throw journalError('该文件已存在，请刷新后打开', 409, 'REVISION_CONFLICT'); throw e; }
    }
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
