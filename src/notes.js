/**
 * 手记：用户自己写的「今天做了什么」，以及配的图片。
 * 文字存 day_state.notes_json；图片文件放数据目录 notes/<日期>/<id>.<ext>，清单也在 notes_json 里。
 * 图片只在两处被读：网页里显示缩略图、以及（开了 ai.vision 时）发给模型。不做任何识别。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir } from './config.js';

export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
export const MAX_IMAGES_PER_DAY = 8;
export const ALLOWED_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

export function notesDir(localDate) {
  return path.join(dataDir(), 'notes', String(localDate).replace(/[^\d-]/g, ''));
}

/**
 * 存一张图。data 是 base64（可带 data: 前缀）。
 * @returns {{id:string,name:string,mime:string,path:string,bytes:number,ts:string}}
 */
export function addImage(localDate, { name, mime, data, ts }, existing = []) {
  if (existing.length >= MAX_IMAGES_PER_DAY) throw new Error(`一天最多 ${MAX_IMAGES_PER_DAY} 张图`);
  let m = String(mime ?? '').toLowerCase();
  let b64 = String(data ?? '');
  const dm = b64.match(/^data:([^;]+);base64,(.*)$/s);
  if (dm) {
    m = m || dm[1].toLowerCase();
    b64 = dm[2];
  }
  const ext = ALLOWED_MIME[m];
  if (!ext) throw new Error('只接受 PNG / JPEG / WebP / GIF');
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw new Error('图片是空的');
  if (buf.length > MAX_IMAGE_BYTES) throw new Error(`图片超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB`);
  const id = crypto.randomBytes(8).toString('hex');
  const dir = notesDir(localDate);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.${ext}`);
  fs.writeFileSync(file, buf);
  const clean = String(name ?? '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 80) || `图片.${ext}`;
  return { id, name: clean, mime: m, path: file, bytes: buf.length, ts: ts ?? new Date().toISOString() };
}

export function removeImage(image) {
  try {
    if (image?.path) fs.rmSync(image.path, { force: true });
  } catch {
    /* 文件已经没了也算删成功 */
  }
}

/** 读成 base64，给模型或网页用。文件丢了返回 null。 */
export function imageBase64(image) {
  try {
    return { mime: image.mime, data: fs.readFileSync(image.path).toString('base64') };
  } catch {
    return null;
  }
}
