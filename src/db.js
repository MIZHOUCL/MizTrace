/**
 * 存储层：node:sqlite（Node 内置，无原生依赖，含 FTS5）。
 * 6 张表，理由见规划文档 ADR-017。
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { dbPath, ensureDataDir } from './config.js';

export const SCHEMA_VERSION = 5;

const MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE projects (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        root_path     TEXT UNIQUE,
        user_renamed  INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL
      );
      CREATE TABLE sessions (
        id             TEXT PRIMARY KEY,
        provider_id    TEXT NOT NULL,
        thread_id      TEXT NOT NULL,
        title          TEXT,
        cwd            TEXT,
        git_branch     TEXT,
        project_id     TEXT,
        first_ts       TEXT,
        last_ts        TEXT,
        content_status TEXT NOT NULL DEFAULT 'summary_imported',
        schema_version TEXT
      );
      CREATE TABLE commits (
        hash         TEXT PRIMARY KEY,
        project_id   TEXT,
        message      TEXT,
        author       TEXT,
        committed_at TEXT,
        branch       TEXT,
        files        INTEGER DEFAULT 0,
        additions    INTEGER DEFAULT 0,
        deletions    INTEGER DEFAULT 0
      );
      CREATE TABLE evidence (
        id          TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        source_ref  TEXT NOT NULL,
        project_id  TEXT,
        path        TEXT,
        path_alias  TEXT,
        occurred_at TEXT NOT NULL,
        local_date  TEXT NOT NULL,
        level       TEXT NOT NULL DEFAULT 'L0',
        excerpt     TEXT,
        UNIQUE (source_type, source_ref, local_date)
      );
      CREATE INDEX idx_evidence_date ON evidence (local_date, project_id);
      CREATE TABLE facts (
        id          TEXT PRIMARY KEY,
        journal_id  TEXT,
        project_id  TEXT,
        text        TEXT NOT NULL,
        source_ids  TEXT NOT NULL DEFAULT '[]',
        confidence  TEXT NOT NULL DEFAULT 'unverified',
        occurred_at TEXT,
        local_date  TEXT
      );
      CREATE TABLE journals (
        id         TEXT PRIMARY KEY,
        local_date TEXT UNIQUE NOT NULL,
        markdown   TEXT,
        out_path   TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    // 每天的选择状态：哪些模块被用户排除、AI 草稿。键用 modules.js 的 moduleKey，跨运行稳定。
    sql: `
      CREATE TABLE day_state (
        local_date    TEXT PRIMARY KEY,
        excluded_json TEXT NOT NULL DEFAULT '[]',
        draft_md      TEXT,
        draft_json    TEXT,
        updated_at    TEXT NOT NULL
      );
    `,
  },
  {
    version: 3,
    // AI 调用账本（规划阶段 C）：每次调用记 token 与耗时，前端显示今日用量，dailyLimit 靠它判断。
    sql: `
      CREATE TABLE ai_runs (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        local_date    TEXT NOT NULL,
        protocol      TEXT,
        model         TEXT,
        input_tokens  INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        latency_ms    INTEGER DEFAULT 0,
        ok            INTEGER NOT NULL DEFAULT 1,
        error         TEXT,
        created_at    TEXT NOT NULL
      );
      CREATE INDEX idx_ai_runs_date ON ai_runs (local_date);
    `,
  },
  {
    version: 4,
    // 每个模块可附一段给模型的「写法要求」：{ [moduleKey]: text }。只影响 AI 写作，规则版不看。
    sql: `
      ALTER TABLE day_state ADD COLUMN hints_json TEXT NOT NULL DEFAULT '{}';
    `,
  },
  {
    version: 5,
    // 手记：用户自己写的「今天做了什么」+ 上传的图片清单 { text, updatedAt, images: [{ id, name, mime, path, bytes, ts }] }。
    // 图片文件放数据目录 notes/<日期>/ 下，这里只存清单。
    sql: `
      ALTER TABLE day_state ADD COLUMN notes_json TEXT NOT NULL DEFAULT '{}';
    `,
  },
];

export const EMPTY_NOTES = Object.freeze({ text: '', updatedAt: null, images: [] });

function parseNotes(raw) {
  try {
    const n = raw ? JSON.parse(raw) : null;
    if (!n || typeof n !== 'object') return { ...EMPTY_NOTES, images: [] };
    return { text: typeof n.text === 'string' ? n.text : '', updatedAt: typeof n.updatedAt === 'string' ? n.updatedAt : null, images: Array.isArray(n.images) ? n.images.filter((i) => i && typeof i.id === 'string') : [] };
  } catch {
    return { ...EMPTY_NOTES, images: [] };
  }
}

/**
 * 打开数据库并执行迁移。
 * @param {string} [file] 传 ':memory:' 用于测试
 * @returns {DatabaseSync}
 */
export function openDb(file) {
  const target = file || dbPath();
  if (target !== ':memory:') {
    ensureDataDir();
    fs.mkdirSync(path.dirname(target), { recursive: true });
  }
  const db = new DatabaseSync(target);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  return db;
}

/** 顺序迁移，幂等。 */
export function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(m.version, new Date().toISOString());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`迁移 ${m.version} 失败：${err.message}`);
    }
  }
  return currentVersion(db);
}

export function currentVersion(db) {
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get();
  return row?.v ?? 0;
}

/**
 * 幂等写入证据。同 (source_type, source_ref, local_date) 重复插入不会产生新行。
 * @returns {{id:string, inserted:boolean}}
 */
export function upsertEvidence(db, ev) {
  const id = ev.id || `${ev.source_type}:${ev.source_ref}:${ev.local_date}`;
  const info = db
    .prepare(
      `INSERT INTO evidence (id, source_type, source_ref, project_id, path, path_alias, occurred_at, local_date, level, excerpt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source_type, source_ref, local_date) DO NOTHING`,
    )
    .run(id, ev.source_type, ev.source_ref, ev.project_id ?? null, ev.path ?? null, ev.path_alias ?? null, ev.occurred_at, ev.local_date, ev.level ?? 'L0', ev.excerpt ?? null);
  return { id, inserted: info.changes > 0 };
}

/**
 * 证据引用是否真实存在（供 facts.js 的引用完整性校验使用）。
 * @param {string|string[]} localDate 单个归属日，或一段区间内的全部归属日（week 汇总时传数组）。
 *   只传末日会让区间内其他天的证据全部被判成「缺失」——week 曾因此整篇 unverified。
 */
export function evidenceExists(db, sourceType, sourceRef, localDate) {
  const dates = Array.isArray(localDate) ? localDate : [localDate];
  if (!dates.length) return false;
  const row = db
    .prepare(`SELECT 1 AS ok FROM evidence WHERE source_type = ? AND source_ref = ? AND local_date IN (${dates.map(() => '?').join(', ')})`)
    .get(sourceType, sourceRef, ...dates);
  return Boolean(row);
}


/**
 * 某天的用户选择与草稿。
 * excluded_json 里存的是 overrides：{ [moduleKey]: true|false }。
 * 三态是必须的 —— 解压/杂项默认排除，用户可能想把它捞回来；普通模块默认选中，用户可能戳掉。
 * 只存用户明确动过的键，其余沿用模块自己的默认值。
 */
export function getDayState(db, localDate) {
  const row = db.prepare('SELECT excluded_json, hints_json, notes_json, draft_md, draft_json, updated_at FROM day_state WHERE local_date = ?').get(localDate);
  let overrides = {};
  let hints = {};
  let draftJson = null;
  try {
    const parsed = row ? JSON.parse(row.excluded_json || '{}') : {};
    // 兼容早期数组格式：数组 = 全部视为排除
    overrides = Array.isArray(parsed) ? Object.fromEntries(parsed.map((k) => [k, false])) : parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    overrides = {};
  }
  try {
    // hints_json：{ [moduleKey]: 写法要求 }
    const parsed = row?.hints_json ? JSON.parse(row.hints_json) : {};
    hints = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    hints = {};
  }
  try {
    draftJson = row?.draft_json ? JSON.parse(row.draft_json) : null;
  } catch {
    draftJson = null;
  }
  return { localDate, overrides, hints, notes: parseNotes(row?.notes_json), draftMd: row?.draft_md ?? null, draftJson, updatedAt: row?.updated_at ?? null };
}

/** 保存手记（整份覆盖）。返回保存后的手记。 */
export function setNotes(db, localDate, notes) {
  const next = { text: String(notes?.text ?? '').slice(0, 20_000), updatedAt: notes?.updatedAt ?? new Date().toISOString(), images: Array.isArray(notes?.images) ? notes.images : [] };
  db.prepare(
    `INSERT INTO day_state (local_date, notes_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (local_date) DO UPDATE SET notes_json = excluded.notes_json, updated_at = excluded.updated_at`,
  ).run(localDate, JSON.stringify(next), new Date().toISOString());
  return next;
}

/** 覆盖某天的选择 overrides。传 {} 即清空。 */
export function setOverrides(db, localDate, overrides) {
  const now = new Date().toISOString();
  const clean = {};
  for (const [k, v] of Object.entries(overrides ?? {})) if (typeof v === 'boolean') clean[k] = v;
  db.prepare(
    `INSERT INTO day_state (local_date, excluded_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (local_date) DO UPDATE SET excluded_json = excluded.excluded_json, updated_at = excluded.updated_at`,
  ).run(localDate, JSON.stringify(clean), now);
}

/**
 * 给某天某个模块记一段「写法要求」，AI 写作时附在该模块的证据前面；空字符串 = 删除。
 * 只影响「生成日记」，规则版不看它。返回更新后的全部 hints。
 */
export function setHint(db, localDate, key, text) {
  const { hints } = getDayState(db, localDate);
  const next = { ...hints };
  const t = String(text ?? '').trim().slice(0, 2000);
  if (t) next[key] = t;
  else delete next[key];
  db.prepare(
    `INSERT INTO day_state (local_date, hints_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (local_date) DO UPDATE SET hints_json = excluded.hints_json, updated_at = excluded.updated_at`,
  ).run(localDate, JSON.stringify(next), new Date().toISOString());
  return next;
}

/** 保存 AI 草稿（Markdown + 结构化条目）。 */
export function setDraft(db, localDate, markdown, json) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO day_state (local_date, draft_md, draft_json, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (local_date) DO UPDATE SET draft_md = excluded.draft_md, draft_json = excluded.draft_json, updated_at = excluded.updated_at`,
  ).run(localDate, markdown ?? null, json ? JSON.stringify(json) : null, now);
}

/** 记一笔 AI 调用。 */
export function logAiRun(db, run) {
  db.prepare(
    `INSERT INTO ai_runs (local_date, protocol, model, input_tokens, output_tokens, latency_ms, ok, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    run.localDate,
    run.protocol ?? null,
    run.model ?? null,
    run.inputTokens ?? 0,
    run.outputTokens ?? 0,
    run.latencyMs ?? 0,
    run.ok ? 1 : 0,
    run.error ? String(run.error).slice(0, 500) : null,
    new Date().toISOString(),
  );
}

/** 某个自然日（按 created_at 的 UTC 日期前缀）已调用次数与 token。 */
export function aiUsageToday(db, localDate) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output
       FROM ai_runs WHERE local_date = ? AND ok = 1`,
    )
    .get(localDate);
  return { calls: row?.calls ?? 0, input: row?.input ?? 0, output: row?.output ?? 0 };
}
