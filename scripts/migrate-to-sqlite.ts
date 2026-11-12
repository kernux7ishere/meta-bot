// One-off migration: D1 (via the gateway Worker) + the old local JSON
// files  →  local SQLite (bot.db).
//
// READ-ONLY sources: nothing here deletes or modifies D1 or the JSON
// files. The script only READS them and writes into the target SQLite
// file. It is idempotent-ish (re-runnable): every write upserts by
// primary key, messages are skipped when the id already exists.
//
// Usage (from the bot dir on Lightsail, bot STOPPED):
//   GATEWAY_URL=https://messenger-userbot-gateway.earthly-gab-serve.workers.dev \
//   GATEWAY_TOKEN=$(cat ~/.gateway-token-new) \
//   npx tsx scripts/migrate-to-sqlite.ts \
//     --threads 8835038716594816 \
//     --db ./bot.db
//
// Flags:
//   --threads id1,id2,...   Thread ids to migrate from D1 (comma-separated).
//                           The self-thread id is also fetched from the
//                           gateway and added automatically.
//   --db <path>             Target SQLite file (default ./bot.db).
//   --json-dir <dir>        Directory holding the old JSON files
//                           (default: the current directory, i.e. the bot dir).
//   --dry-run               Print counts per source/table, write nothing.
//   --skip-gateway          Migrate JSON files only (no D1 reads).
//   --skip-json             Migrate D1 only (no JSON reads).
//
// How to find thread ids (the gateway has no "list all threads"
// endpoint, so they must be supplied):
//   - The test group: 8835038716594816.
//   - The owner's self-chat + E2EE DM thread ids: grep the bot journal
//     for "threadID" (journalctl --user -u messenger-userbot.service),
//     or take them from a D1 dump if one exists.
//   - Any thread the bot ever saved a message in is worth including;
//     a thread left out simply keeps its D1 data (nothing is deleted)
//     and can be migrated later by re-running with --threads extended.
//     Re-running is safe: upserts skip what is already there.
//
// Known gaps (documented, not bugs):
//   - /messages/:threadId caps at 200 rows per call and has no paging,
//     so at most the latest 200 saved messages per thread migrate.
//     The bot only ever reads the recent history anyway.
//   - Bot-message ids (bot_messages table) CANNOT migrate: the gateway
//     has no list endpoint for them, only a check-by-id. They are a
//     dedup cache for the bot's own echoes; the bot re-records its own
//     sends going forward, and the router also ignores echoes by sender
//     id, so losing the old ids is harmless.
//   - Typing modes / presence / model / reminders / sticker data that
//     only ever lived in JSON files migrate from those files; if a file
//     is missing (e.g. presence.json never existed because .presence
//     was never turned off), that store starts empty, which is the same
//     as its default.
//
// NEVER print the gateway token: it is read from the environment only,
// and only the counts are logged.

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initSchema } from "../src/db/sqlite-conn.js";
import { normalizeImageUrl } from "../src/sent-images.js";

const GATEWAY_TIMEOUT_MS = 20_000;

export interface GatewayReader {
  get<T>(endpoint: string): Promise<T>;
}

export function createGatewayReader(baseUrl: string, token: string): GatewayReader {
  const base = baseUrl.replace(/\/+$/, "");
  return {
    async get<T>(endpoint: string): Promise<T> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT_MS);
      try {
        const res = await fetch(`${base}${endpoint}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(`Gateway GET ${endpoint} failed: HTTP ${res.status}`);
        }
        return (await res.json()) as T;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// JSON importers (exported for tests). Each takes the target db + the
// parsed JSON content and returns how many rows it wrote. All are
// idempotent: re-running skips what is already there.
// ---------------------------------------------------------------------------

function readJsonFile(dir: string, name: string): unknown | undefined {
  const file = path.join(dir, name);
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return undefined;
  }
}

export function importTypingModes(db: DatabaseSync, data: unknown): number {
  if (!data || typeof data !== "object") return 0;
  const upsert = db.prepare("INSERT OR REPLACE INTO typing_modes (thread_id, mode) VALUES (?, ?)");
  let n = 0;
  for (const [threadId, mode] of Object.entries(data as Record<string, unknown>)) {
    if (mode !== "user" && mode !== "bot") continue;
    upsert.run(threadId, mode);
    n++;
  }
  return n;
}

export function importPresence(db: DatabaseSync, data: unknown): number {
  if (!data || typeof data !== "object") return 0;
  const enabled = (data as { enabled?: unknown }).enabled;
  if (typeof enabled !== "boolean") return 0;
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('presence_enabled', ?)").run(
    enabled ? "1" : "0"
  );
  return 1;
}

export function importModel(db: DatabaseSync, data: unknown): number {
  if (!data || typeof data !== "object") return 0;
  const model = (data as { model?: unknown }).model;
  if (typeof model !== "string" || model.trim().length === 0) return 0;
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('llm_model', ?)").run(model.trim());
  return 1;
}

export function importReminders(db: DatabaseSync, data: unknown): number {
  if (!Array.isArray(data)) return 0;
  const insert = db.prepare(
    "INSERT OR IGNORE INTO reminders (id, thread_id, fire_at, text, mentions, requester_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  let n = 0;
  for (const r of data as any[]) {
    if (!r || typeof r.id !== "string" || typeof r.threadId !== "string") continue;
    const info = insert.run(
      r.id,
      r.threadId,
      Number(r.fireAt) || 0,
      String(r.text ?? ""),
      JSON.stringify(Array.isArray(r.mentions) ? r.mentions : []),
      String(r.requesterId ?? ""),
      Number(r.createdAt) || 0
    );
    n += Number(info.changes);
  }
  return n;
}

export function importStickerPack(db: DatabaseSync, data: unknown): number {
  if (!Array.isArray(data)) return 0;
  const insert = db.prepare(
    "INSERT OR IGNORE INTO sticker_pack (id, name, label, emotion, source, context, learned_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  let n = 0;
  for (const e of data as any[]) {
    if (!e || typeof e.id !== "string") continue;
    if (e.source === "builtin") continue; // already seeded by initSchema
    const info = insert.run(
      e.id,
      String(e.name ?? ""),
      String(e.label ?? ""),
      String(e.emotion ?? ""),
      String(e.source ?? ""),
      typeof e.context === "string" ? e.context : null,
      Number(e.learnedAt) || 0
    );
    n += Number(info.changes);
  }
  return n;
}

type SentImageJsonEntry = string | { url?: unknown; query?: unknown; title?: unknown; sentAt?: unknown };

export function importSentImages(db: DatabaseSync, data: unknown): number {
  if (!data || typeof data !== "object") return 0;
  const insert = db.prepare(
    "INSERT OR IGNORE INTO sent_images (thread_id, url, url_norm, query, title, sent_at) VALUES (?, ?, ?, ?, ?, ?)"
  );
  let n = 0;
  for (const [threadId, entries] of Object.entries(data as Record<string, SentImageJsonEntry[]>)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      // Legacy format: plain URL strings (pre-2026-11-11 files).
      const url = typeof entry === "string" ? entry : String((entry as any)?.url ?? "");
      if (!url) continue;
      const info = insert.run(
        threadId,
        url,
        normalizeImageUrl(url),
        typeof entry === "object" && typeof (entry as any).query === "string" ? (entry as any).query : null,
        typeof entry === "object" && typeof (entry as any).title === "string" ? (entry as any).title : null,
        typeof entry === "object" ? Number((entry as any).sentAt) || 0 : 0
      );
      n += Number(info.changes);
    }
  }
  return n;
}

export function importRecentAttachments(db: DatabaseSync, data: unknown): number {
  if (!data || typeof data !== "object") return 0;
  const exists = db.prepare(
    "SELECT seq FROM recent_attachments WHERE thread_id = ? AND message_id = ? LIMIT 1"
  );
  const insert = db.prepare(
    "INSERT INTO recent_attachments (thread_id, message_id, url, name, type, mime, size, sender_id, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  let n = 0;
  for (const [threadId, list] of Object.entries(data as Record<string, any[]>)) {
    if (!Array.isArray(list)) continue;
    // Group by message (the store dedups by message id, not by row).
    const byMessage = new Map<string, any[]>();
    for (const a of list) {
      if (!a || typeof a.messageId !== "string") continue;
      const arr = byMessage.get(a.messageId) || [];
      arr.push(a);
      byMessage.set(a.messageId, arr);
    }
    for (const [messageId, atts] of byMessage) {
      if (exists.get(threadId, messageId)) continue;
      for (const a of atts) {
        if (!a.url && !a.name) continue;
        insert.run(
          threadId,
          messageId,
          String(a.url ?? ""),
          typeof a.name === "string" ? a.name : null,
          String(a.type ?? "file"),
          typeof a.mime === "string" ? a.mime : null,
          typeof a.size === "number" ? a.size : null,
          String(a.senderId ?? ""),
          Number(a.receivedAt) || 0
        );
        n++;
      }
    }
  }
  return n;
}

export function importMessageLinks(db: DatabaseSync, data: unknown): number {
  if (!data || typeof data !== "object") return 0;
  const upsert = db.prepare(
    `INSERT INTO message_links (thread_id, message_id, reply_to_id) VALUES (?, ?, ?)
     ON CONFLICT(thread_id, message_id) DO UPDATE SET reply_to_id = excluded.reply_to_id`
  );
  let n = 0;
  for (const [threadId, links] of Object.entries(data as Record<string, Record<string, string>>)) {
    if (!links || typeof links !== "object") continue;
    for (const [messageId, replyToId] of Object.entries(links)) {
      if (!messageId || !replyToId) continue;
      upsert.run(threadId, messageId, replyToId);
      n++;
    }
  }
  return n;
}

export function importStickerVec(db: DatabaseSync, data: unknown): number {
  if (!data || typeof data !== "object") return 0;
  const insert = db.prepare(
    `INSERT INTO sticker_vec (thread_id, id, description, embedding, dimensions, last_seen) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(thread_id, id) DO UPDATE SET description = excluded.description, embedding = excluded.embedding, dimensions = excluded.dimensions, last_seen = excluded.last_seen`
  );
  let n = 0;
  for (const [threadId, list] of Object.entries(data as Record<string, any[]>)) {
    if (!Array.isArray(list)) continue;
    for (const r of list) {
      if (!r || typeof r.id !== "string") continue;
      const embedding = Array.isArray(r.embedding) ? r.embedding : [];
      insert.run(
        threadId,
        r.id,
        String(r.description ?? ""),
        JSON.stringify(embedding),
        Number(r.dimensions) || embedding.length,
        Number(r.lastSeen) || 0
      );
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// D1 import (gateway GETs only)
// ---------------------------------------------------------------------------

interface ThreadD1 {
  threadId: string;
  aiEnabled: boolean;
  memory: string;
  style: any;
  personas: any[];
  access: any;
  messages: any[];
}

async function fetchThreadD1(gw: GatewayReader, threadId: string): Promise<ThreadD1> {
  // Each endpoint is fetched independently: a single missing route
  // must not lose the whole thread. In particular GET /personas/:id
  // 404s when the persona worker routes were never deployed (the
  // known blocker) — that only means "no personas", not "no data".
  const getOr = async <T>(endpoint: string, fallback: T): Promise<T> => {
    try {
      return await gw.get<T>(endpoint);
    } catch (err: any) {
      console.log(`  (gateway ${endpoint}: ${err?.message || err} — using empty default)`);
      return fallback;
    }
  };
  const [thread, memory, style, personas, access, messages] = await Promise.all([
    getOr<{ ai_enabled?: boolean }>(`/thread/${encodeURIComponent(threadId)}`, {}),
    getOr<{ content?: string }>(`/memory/${encodeURIComponent(threadId)}`, {}),
    getOr<any>(`/style/${encodeURIComponent(threadId)}`, {}),
    getOr<{ personas?: any[] }>(`/personas/${encodeURIComponent(threadId)}`, {}),
    getOr<any>(`/access/${encodeURIComponent(threadId)}`, {}),
    getOr<{ messages?: any[] }>(`/messages/${encodeURIComponent(threadId)}?limit=200`, {}),
  ]);
  return {
    threadId,
    aiEnabled: Boolean(thread?.ai_enabled),
    memory: String(memory?.content ?? ""),
    style: style ?? {},
    personas: Array.isArray(personas?.personas) ? personas.personas : [],
    access: access ?? {},
    messages: Array.isArray(messages?.messages) ? messages.messages : [],
  };
}

export function writeThreadD1(
  db: DatabaseSync,
  t: ThreadD1
): { messages: number; personas: number; access: number } {
  const now = Date.now();
  // Thread settings (ai_enabled).
  db.prepare(
    `INSERT INTO threads (thread_id, ai_enabled, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET ai_enabled = excluded.ai_enabled, updated_at = excluded.updated_at`
  ).run(t.threadId, t.aiEnabled ? 1 : 0, now);
  // Memory.
  if (t.memory) {
    db.prepare(
      `INSERT INTO memory (thread_id, content, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`
    ).run(t.threadId, t.memory, now);
  }
  // Style (partial fields come from the worker GET as full defaults).
  const s = t.style;
  db.prepare(
    `INSERT INTO thread_style (thread_id, content, auto_learn, owner_msgs_since_learn, access_mode, sources, active_persona, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET
       content = excluded.content, auto_learn = excluded.auto_learn,
       owner_msgs_since_learn = excluded.owner_msgs_since_learn,
       access_mode = excluded.access_mode, sources = excluded.sources,
       active_persona = excluded.active_persona, updated_at = excluded.updated_at`
  ).run(
    t.threadId,
    String(s.content ?? ""),
    s.auto_learn ? 1 : 0,
    Number(s.owner_msgs_since_learn) || 0,
    String(s.access_mode ?? "off"),
    JSON.stringify(Array.isArray(s.sources) ? s.sources : []),
    String(s.active_persona ?? "default"),
    Number(s.updated_at) || now
  );
  // Personas.
  const upsertPersona = db.prepare(
    `INSERT INTO personas (thread_id, name, content, sources, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(thread_id, name) DO UPDATE SET content = excluded.content, sources = excluded.sources, updated_at = excluded.updated_at`
  );
  let personas = 0;
  for (const p of t.personas) {
    if (!p || typeof p.name !== "string") continue;
    upsertPersona.run(
      t.threadId,
      p.name,
      String(p.content ?? ""),
      JSON.stringify(Array.isArray(p.sources) ? p.sources : []),
      Number(p.created_at) || now,
      Number(p.updated_at) || now
    );
    personas++;
  }
  // Access list (per-thread white/black).
  const upsertAccess = db.prepare(
    "INSERT OR REPLACE INTO access_list (thread_id, user_id, list_type, created_at) VALUES (?, ?, ?, ?)"
  );
  let access = 0;
  for (const userId of Array.isArray(t.access.whitelist) ? t.access.whitelist : []) {
    upsertAccess.run(t.threadId, String(userId), "white", now);
    access++;
  }
  for (const userId of Array.isArray(t.access.blacklist) ? t.access.blacklist : []) {
    upsertAccess.run(t.threadId, String(userId), "black", now);
    access++;
  }
  // Messages (skip ids already present — re-runs are safe).
  const insertMsg = db.prepare(
    "INSERT OR IGNORE INTO messages (id, thread_id, sender_id, sender_name, body, reply_to_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  let messages = 0;
  for (const m of t.messages) {
    if (!m || typeof m.id !== "string") continue;
    const info = insertMsg.run(
      m.id,
      t.threadId,
      String(m.sender_id ?? ""),
      typeof m.sender_name === "string" ? m.sender_name : null,
      typeof m.body === "string" ? m.body : "",
      typeof m.reply_to_id === "string" ? m.reply_to_id : null,
      Number(m.created_at) || now
    );
    messages += Number(info.changes);
  }
  return { messages, personas, access };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  threads: string[];
  dbPath: string;
  jsonDir: string;
  dryRun: boolean;
  skipGateway: boolean;
  skipJson: boolean;
} {
  const out = {
    threads: [] as string[],
    dbPath: "./bot.db",
    jsonDir: process.cwd(),
    dryRun: false,
    skipGateway: false,
    skipJson: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--threads" && argv[i + 1]) out.threads = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith("--threads=")) out.threads = a.slice("--threads=".length).split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--db" && argv[i + 1]) out.dbPath = argv[++i];
    else if (a.startsWith("--db=")) out.dbPath = a.slice("--db=".length);
    else if (a === "--json-dir" && argv[i + 1]) out.jsonDir = argv[++i];
    else if (a.startsWith("--json-dir=")) out.jsonDir = a.slice("--json-dir=".length);
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--skip-gateway") out.skipGateway = true;
    else if (a === "--skip-json") out.skipJson = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: migrate-to-sqlite.ts --threads id1,id2 [--db ./bot.db] [--json-dir .] [--dry-run] [--skip-gateway] [--skip-json]\n" +
          "Env: GATEWAY_URL, GATEWAY_TOKEN (needed unless --skip-gateway)."
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a} (see --help)`);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const counts: Record<string, number> = {};
  const add = (key: string, n: number) => {
    counts[key] = (counts[key] ?? 0) + n;
  };

  let db: DatabaseSync | null = null;
  if (!args.dryRun) {
    db = new DatabaseSync(args.dbPath);
    initSchema(db);
  }

  // --- D1 via the gateway (read-only GETs) ---
  if (!args.skipGateway) {
    const gatewayUrl = process.env.GATEWAY_URL || "";
    const gatewayToken = process.env.GATEWAY_TOKEN || "";
    if (!gatewayUrl || !gatewayToken) {
      console.log("No GATEWAY_URL/GATEWAY_TOKEN in env — skipping D1 import (use --skip-gateway to silence this).");
    } else {
      const gw = createGatewayReader(gatewayUrl, gatewayToken);
      const threadIds = [...new Set(args.threads)];
      // The self-thread id comes from the gateway too.
      try {
        const self = await gw.get<{ threadId?: string | null }>("/self-thread");
        if (self?.threadId && !threadIds.includes(self.threadId)) {
          threadIds.push(self.threadId);
          console.log(`Self-thread id from gateway: ${self.threadId}`);
        }
      } catch (err: any) {
        console.log(`Could not fetch /self-thread (${err?.message || err}) — continuing without it.`);
      }
      // Global blacklist.
      try {
        const global = await gw.get<{ blacklist?: string[] }>("/access/global");
        const list = Array.isArray(global?.blacklist) ? global.blacklist : [];
        if (db) {
          const upsert = db.prepare(
            "INSERT OR REPLACE INTO access_global (user_id, list_type, created_at) VALUES (?, 'black', ?)"
          );
          for (const userId of list) upsert.run(String(userId), Date.now());
        }
        add("access_global", list.length);
      } catch (err: any) {
        console.log(`Could not fetch /access/global (${err?.message || err}) — continuing.`);
      }
      for (const threadId of threadIds) {
        try {
          const t = await fetchThreadD1(gw, threadId);
          if (db) {
            const w = writeThreadD1(db, t);
            add("messages", w.messages);
            add("personas", w.personas);
            add("access_list", w.access);
          } else {
            add("messages", t.messages.length);
            add("personas", t.personas.length);
            add(
              "access_list",
              (Array.isArray(t.access.whitelist) ? t.access.whitelist.length : 0) +
                (Array.isArray(t.access.blacklist) ? t.access.blacklist.length : 0)
            );
          }
          add("threads", 1);
          console.log(
            `Thread ${threadId}: ${t.messages.length} messages, ${t.personas.length} personas, ` +
              `ai=${t.aiEnabled}, style=${t.style?.active_persona ?? "default"}`
          );
        } catch (err: any) {
          console.log(`Thread ${threadId}: FAILED (${err?.message || err}) — skipped, continuing.`);
        }
      }
    }
  }

  // --- Old local JSON files (read-only) ---
  if (!args.skipJson) {
    const jobs: Array<[string, string, (db: DatabaseSync, data: unknown) => number]> = [
      ["typing-modes.json", "typing_modes", importTypingModes],
      ["presence.json", "presence", importPresence],
      ["llm-model.json", "llm_model", importModel],
      ["reminders.json", "reminders", importReminders],
      ["sticker-pack.json", "sticker_pack", importStickerPack],
      ["sent-images.json", "sent_images", importSentImages],
      ["recent-attachments.json", "recent_attachments", importRecentAttachments],
      ["recent-message-links.json", "message_links", importMessageLinks],
      ["sticker-vec.json", "sticker_vec", importStickerVec],
    ];
    for (const [file, key, fn] of jobs) {
      const data = readJsonFile(args.jsonDir, file);
      if (data === undefined) {
        console.log(`${file}: not present — skipped.`);
        continue;
      }
      // In dry-run mode there is no db; count from the parsed data by
      // running the importer against a throwaway in-memory database.
      const target = db ?? new DatabaseSync(":memory:");
      if (!db) initSchema(target);
      const n = fn(target, data);
      add(key, n);
      console.log(`${file}: ${n} row(s)${args.dryRun ? " (dry-run, not written)" : ""}.`);
      if (!db) target.close();
    }
  }

  // --- Summary + verification ---
  console.log("\n--- Summary ---");
  for (const [key, n] of Object.entries(counts)) {
    console.log(`  ${key}: ${n}`);
  }
  if (db) {
    console.log("\n--- Verify (re-read from target db) ---");
    const tables = [
      "threads",
      "memory",
      "thread_style",
      "personas",
      "access_list",
      "access_global",
      "messages",
      "typing_modes",
      "sticker_pack",
      "sent_images",
      "recent_attachments",
      "message_links",
      "sticker_vec",
      "reminders",
      "settings",
    ];
    for (const table of tables) {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      console.log(`  ${table}: ${row.n}`);
    }
    db.close();
    console.log(`\nDone. Target: ${path.resolve(args.dbPath)}`);
  } else {
    console.log("\nDry-run: nothing was written.");
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error("Migration failed:", err?.message || err);
    process.exit(1);
  });
}
