// Shared SQLite connection + schema for the local bot store.
//
// ONE store, ONE file: every persistent thing the bot keeps (thread
// settings, memory, styles, personas, access lists, messages, typing
// modes, presence, sticker pack, sent images, recent attachments,
// sticker vectors, reminders, the current LLM model) lives in a single
// SQLite file, `bot.db` next to the bot. This replaces the old split:
// D1 (via the Cloudflare gateway Worker) for the "real" data plus a
// pile of local JSON files for everything added since the worker deploy
// got blocked. D1 stays only as a rollback fallback (DB_BACKEND=gateway).
//
// This module is deliberately dependency-free (no logger, no config):
// src/llm/model.ts imports it, and model.ts must NOT import logger or
// config (circular import — config imports model for the `model`
// getter). It reads SQLITE_PATH straight from process.env.
//
// Path: env SQLITE_PATH, default "./bot.db" (relative to process cwd,
// which is the bot dir). ":memory:" is allowed (used by the test suite).

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

/** Schema version, stored in the `meta` table. Bump + add a migration
 *  in initSchema when the schema changes in a later release. */
export const SCHEMA_VERSION = 1;

/** Built-in Like stickers, seeded on first init (same three as the old
 *  sticker-pack.json BUILTIN list). They are rows like any other, with
 *  source='builtin', so tagSticker can refuse to re-tag them. */
export const BUILTIN_STICKERS: Array<{
  id: string;
  name: string;
  label: string;
  emotion: string;
}> = [
  { id: "369239263222822", name: "like", label: "Like (vừa)", emotion: "agree" },
  { id: "369239383222810", name: "like_small", label: "Like (nhỏ)", emotion: "agree" },
  { id: "369239343222814", name: "like_large", label: "Like (lớn)", emotion: "agree" },
];

const SCHEMA_STATEMENTS: string[] = [
  // Bookkeeping.
  `CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  // Generic single-row settings (self_thread_id, presence_enabled,
  // llm_model) — one table instead of three one-off files.
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  // --- DatabaseService core (mirrors the D1 schema in worker/src/index.ts) ---
  `CREATE TABLE IF NOT EXISTS threads (
    thread_id TEXT PRIMARY KEY,
    ai_enabled INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS memory (
    thread_id TEXT PRIMARY KEY,
    content TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS thread_style (
    thread_id TEXT PRIMARY KEY,
    content TEXT NOT NULL DEFAULT '',
    auto_learn INTEGER NOT NULL DEFAULT 0,
    owner_msgs_since_learn INTEGER NOT NULL DEFAULT 0,
    access_mode TEXT NOT NULL DEFAULT 'off',
    sources TEXT NOT NULL DEFAULT '[]',
    active_persona TEXT NOT NULL DEFAULT 'default',
    updated_at INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS personas (
    thread_id TEXT NOT NULL,
    name TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    sources TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (thread_id, name)
  )`,
  `CREATE TABLE IF NOT EXISTS access_list (
    thread_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    list_type TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (thread_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS access_global (
    user_id TEXT PRIMARY KEY,
    list_type TEXT NOT NULL DEFAULT 'black',
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    sender_name TEXT,
    body TEXT,
    reply_to_id TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_thread_time ON messages(thread_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS bot_messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  // Durable dedup claims: every incoming message id the router has
  // started processing. Replaces the old in-memory Set (which lost its
  // contents on every restart, and dropped ALL ids when it hit its 1000
  // cap and cleared). Purged with the retention job, same window as
  // messages. A claim is about PROCESSING, not storage: a claimed id
  // may have no row in messages (e.g. a dot-command, which is never
  // saved to history).
  `CREATE TABLE IF NOT EXISTS seen_messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    seen_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_seen_messages_time ON seen_messages(seen_at)`,
  // Sender display-name cache: the sidecar's `members` command is the
  // only source that reliably carries names under Go (message events
  // carry ids only, and getUserInfo returns {}). Populated from member
  // lists + fca getUserInfo results; read at save time so history rows
  // carry a real name instead of null, and by namesFromHistory for
  // @mentions. Names change rarely — last write wins, no expiry.
  `CREATE TABLE IF NOT EXISTS sender_names (
    sender_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  // --- Former JSON files, now tables in the same file ---
  // Typing-indicator work mode per thread (was typing-modes.json).
  `CREATE TABLE IF NOT EXISTS typing_modes (
    thread_id TEXT PRIMARY KEY,
    mode TEXT NOT NULL DEFAULT 'bot'
  )`,
  // Sticker pack (was sticker-pack.json). `seq` is the insertion order:
  // builtins first (seeded in BUILTIN order), then learned stickers in
  // learn order — listStickers() returns this order.
  `CREATE TABLE IF NOT EXISTS sticker_pack (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    emotion TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    context TEXT,
    learned_at INTEGER NOT NULL DEFAULT 0
  )`,
  // Images the bot sent, per thread (was sent-images.json). One row per
  // (thread, normalized URL); re-recording deletes + re-inserts so the
  // row moves to the end (most-recent order by seq).
  `CREATE TABLE IF NOT EXISTS sent_images (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    url TEXT NOT NULL,
    url_norm TEXT NOT NULL,
    query TEXT,
    title TEXT,
    sent_at INTEGER NOT NULL,
    UNIQUE (thread_id, url_norm)
  )`,
  // Files/images others sent, per thread (was recent-attachments.json).
  // `seq` is insertion order (newest last); dedup is by message_id, done
  // in code before insert (same as the JSON version).
  `CREATE TABLE IF NOT EXISTS recent_attachments (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    url TEXT NOT NULL DEFAULT '',
    name TEXT,
    type TEXT NOT NULL DEFAULT 'file',
    mime TEXT,
    size INTEGER,
    sender_id TEXT NOT NULL DEFAULT '',
    received_at INTEGER NOT NULL
  )`,
  // Reply-chain links, messageId -> replied-to messageId, per thread
  // (was recent-message-links.json). `seq` is insertion order so the
  // 200/thread cap can drop the oldest first.
  `CREATE TABLE IF NOT EXISTS message_links (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    reply_to_id TEXT NOT NULL,
    UNIQUE (thread_id, message_id)
  )`,
  // Described stickers + embeddings (was sticker-vec.json). Embedding is
  // stored as JSON text; `seq` is insertion order so the 200/thread cap
  // drops the oldest first and upsert moves a row to the end.
  `CREATE TABLE IF NOT EXISTS sticker_vec (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    id TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    embedding TEXT NOT NULL DEFAULT '[]',
    dimensions INTEGER NOT NULL DEFAULT 0,
    last_seen INTEGER NOT NULL DEFAULT 0,
    UNIQUE (thread_id, id)
  )`,
  // Scheduled reminders (was reminders.json).
  `CREATE TABLE IF NOT EXISTS reminders (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    fire_at INTEGER NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    mentions TEXT NOT NULL DEFAULT '[]',
    requester_id TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )`,
  // Facts/trivia the bot already gave, per thread. Anti-repeat store:
  // the agent records every fact it gives (record_fact tool) and the
  // router injects the most recent ones into its context, so it never
  // gives the same fact twice — not even reworded. `fact_norm` is the
  // dedup key (normalized text); the exact-match dedup is only storage
  // hygiene, the rewording check is the LLM reading the injected list.
  // Cap 200/thread, oldest dropped first (same as sent_images).
  `CREATE TABLE IF NOT EXISTS given_facts (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    fact TEXT NOT NULL,
    fact_norm TEXT NOT NULL,
    given_at INTEGER NOT NULL,
    UNIQUE (thread_id, fact_norm)
  )`,
];

/** Create every table (idempotent) and stamp the schema version. */
export function initSchema(db: DatabaseSync): void {
  for (const sql of SCHEMA_STATEMENTS) {
    db.exec(sql);
  }
  db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)").run(
    String(SCHEMA_VERSION)
  );
  // Builtins are always present, even in a fresh database.
  const seed = db.prepare(
    "INSERT OR IGNORE INTO sticker_pack (id, name, label, emotion, source, learned_at) VALUES (?, ?, ?, ?, 'builtin', 0)"
  );
  for (const b of BUILTIN_STICKERS) {
    seed.run(b.id, b.name, b.label, b.emotion);
  }
}

export function getSqlitePath(): string {
  return process.env.SQLITE_PATH || "./bot.db";
}

let conn: DatabaseSync | null = null;

/**
 * The single shared connection. Opens (and creates, if needed) the
 * database file on first use, enables WAL, and runs the schema.
 * Throws on failure — callers must fail loudly, never silently fall
 * back to an in-memory store (that would lose data).
 */
export function getConnection(): DatabaseSync {
  if (!conn) {
    const dbPath = getSqlitePath();
    if (dbPath !== ":memory:") {
      const dir = path.dirname(path.resolve(dbPath));
      fs.mkdirSync(dir, { recursive: true });
    }
    conn = new DatabaseSync(dbPath);
    // WAL: readers never block the writer (the bot reads constantly
    // while the sidecar writes). On :memory: this is a harmless no-op
    // (reports journal_mode=memory).
    conn.exec("PRAGMA journal_mode = WAL;");
    initSchema(conn);
  }
  return conn;
}

/**
 * Tests only: swap the shared connection for a provided one (typically
 * an in-memory database) and init its schema. Closes the previous
 * connection first. The production code never calls this.
 */
export function setConnectionForTests(db: DatabaseSync): void {
  if (conn) {
    try {
      conn.close();
    } catch {
      // Already closed — ignore.
    }
  }
  conn = db;
  initSchema(conn);
}

/** Close the shared connection (shutdown / tests). */
export function closeConnection(): void {
  if (conn) {
    try {
      conn.close();
    } catch {
      // Already closed — ignore.
    }
    conn = null;
  }
}
