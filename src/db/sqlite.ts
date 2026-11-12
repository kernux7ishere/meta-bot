// SQLite implementation of DatabaseService — the bot's store since the
// 2026-11-11 migration (see docs/sqlite-migration.md).
//
// Same semantics as the old Gateway (D1) client and the InMemory
// fallback: defaults for missing rows, partial style updates, the
// active-persona sync on setThreadStyle, persona created_at preserved
// across upserts, memory consolidation over MEMORY_MAX_CHARS. Only the
// storage changes (local file instead of HTTP + D1).
//
// All methods are synchronous under the hood (DatabaseSync) but keep
// the async interface so callers don't change.

import type { DatabaseSync } from "node:sqlite";
import {
  AccessListData,
  DatabaseService,
  MessageRecord,
  Persona,
  ThreadSettings,
  ThreadStyle,
} from "./types.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { consolidateMemory } from "../llm/consolidation.js";
import { getConnection, initSchema } from "./sqlite-conn.js";

function parseSources(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export class SqliteDatabaseClient implements DatabaseService {
  private db: DatabaseSync;

  /** Pass a DatabaseSync to use it (tests use :memory:); otherwise the
   *  shared singleton connection from sqlite-conn.ts. */
  constructor(db?: DatabaseSync) {
    this.db = db ?? getConnection();
    initSchema(this.db);
  }

  // -- Thread settings -------------------------------------------------

  async getThreadSettings(threadId: string): Promise<ThreadSettings> {
    const row = this.db
      .prepare("SELECT thread_id, ai_enabled, updated_at FROM threads WHERE thread_id = ?")
      .get(threadId) as { thread_id: string; ai_enabled: number; updated_at: number } | undefined;
    return {
      thread_id: threadId,
      ai_enabled: row ? Boolean(row.ai_enabled) : false,
      updated_at: row?.updated_at ?? null,
    };
  }

  async setThreadAiEnabled(threadId: string, enabled: boolean): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO threads (thread_id, ai_enabled, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET ai_enabled = excluded.ai_enabled, updated_at = excluded.updated_at`
      )
      .run(threadId, enabled ? 1 : 0, Date.now());
  }

  // -- Memory ----------------------------------------------------------

  async getMemory(threadId: string): Promise<string> {
    const row = this.db
      .prepare("SELECT content FROM memory WHERE thread_id = ?")
      .get(threadId) as { content: string } | undefined;
    return row?.content || "";
  }

  async setMemory(threadId: string, content: string): Promise<void> {
    let finalContent = content;
    if (finalContent.length > config.memoryMaxChars) {
      finalContent = await consolidateMemory(finalContent);
    }
    this.db
      .prepare(
        `INSERT INTO memory (thread_id, content, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`
      )
      .run(threadId, finalContent, Date.now());
  }

  // -- Thread style + personas ----------------------------------------

  async getThreadStyle(threadId: string): Promise<ThreadStyle> {
    const row = this.db
      .prepare(
        "SELECT thread_id, content, auto_learn, owner_msgs_since_learn, access_mode, sources, active_persona, updated_at FROM thread_style WHERE thread_id = ?"
      )
      .get(threadId) as
      | {
          thread_id: string;
          content: string;
          auto_learn: number;
          owner_msgs_since_learn: number;
          access_mode: string;
          sources: string;
          active_persona: string;
          updated_at: number;
        }
      | undefined;
    return {
      thread_id: threadId,
      content: row?.content ?? "",
      auto_learn: row ? Boolean(row.auto_learn) : false,
      owner_msgs_since_learn: row?.owner_msgs_since_learn ?? 0,
      access_mode: (row?.access_mode as ThreadStyle["access_mode"]) || "off",
      sources: parseSources(row?.sources),
      active_persona: row?.active_persona || "default",
      updated_at: row?.updated_at ?? null,
    };
  }

  async setThreadStyle(
    threadId: string,
    updates: {
      content?: string;
      auto_learn?: boolean;
      owner_msgs_since_learn?: number;
      access_mode?: "off" | "whitelist" | "blacklist";
      sources?: string[];
      active_persona?: string;
    }
  ): Promise<ThreadStyle> {
    const existing = await this.getThreadStyle(threadId);
    const merged: ThreadStyle = {
      thread_id: threadId,
      content: updates.content !== undefined ? updates.content : existing.content,
      auto_learn: updates.auto_learn !== undefined ? updates.auto_learn : existing.auto_learn,
      owner_msgs_since_learn:
        updates.owner_msgs_since_learn !== undefined
          ? updates.owner_msgs_since_learn
          : existing.owner_msgs_since_learn,
      access_mode: updates.access_mode !== undefined ? updates.access_mode : existing.access_mode,
      sources: updates.sources !== undefined ? updates.sources : existing.sources,
      active_persona:
        updates.active_persona !== undefined ? updates.active_persona : existing.active_persona,
      updated_at: Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO thread_style (thread_id, content, auto_learn, owner_msgs_since_learn, access_mode, sources, active_persona, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET
           content = excluded.content,
           auto_learn = excluded.auto_learn,
           owner_msgs_since_learn = excluded.owner_msgs_since_learn,
           access_mode = excluded.access_mode,
           sources = excluded.sources,
           active_persona = excluded.active_persona,
           updated_at = excluded.updated_at`
      )
      .run(
        threadId,
        merged.content,
        merged.auto_learn ? 1 : 0,
        merged.owner_msgs_since_learn,
        merged.access_mode,
        JSON.stringify(merged.sources),
        merged.active_persona,
        merged.updated_at ?? Date.now()
      );
    // Keep the active named persona in sync: any content learned while a
    // persona is active (via .persona save, .persona add, or auto-learn)
    // is written back to that persona's row, so switching away and back
    // keeps it. (Same rule as the gateway client.)
    if (updates.content !== undefined && merged.active_persona !== "default") {
      try {
        await this.savePersona(threadId, merged.active_persona, merged.content, merged.sources);
      } catch (err: any) {
        logger.warn({ err: err.message, threadId, persona: merged.active_persona }, "Failed to sync active persona");
      }
    }
    return merged;
  }

  async getPersonas(threadId: string): Promise<Persona[]> {
    const rows = this.db
      .prepare(
        "SELECT thread_id, name, content, sources, created_at, updated_at FROM personas WHERE thread_id = ? ORDER BY updated_at DESC"
      )
      .all(threadId) as Array<{
      thread_id: string;
      name: string;
      content: string;
      sources: string;
      created_at: number;
      updated_at: number;
    }>;
    return rows.map((r) => ({
      thread_id: r.thread_id,
      name: r.name,
      content: r.content,
      sources: parseSources(r.sources),
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));
  }

  async getPersona(threadId: string, name: string): Promise<Persona | null> {
    const row = this.db
      .prepare(
        "SELECT thread_id, name, content, sources, created_at, updated_at FROM personas WHERE thread_id = ? AND name = ?"
      )
      .get(threadId, name) as
      | {
          thread_id: string;
          name: string;
          content: string;
          sources: string;
          created_at: number;
          updated_at: number;
        }
      | undefined;
    if (!row) return null;
    return {
      thread_id: row.thread_id,
      name: row.name,
      content: row.content,
      sources: parseSources(row.sources),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  async savePersona(
    threadId: string,
    name: string,
    content: string,
    sources: string[] = []
  ): Promise<Persona> {
    const now = Date.now();
    const existing = await this.getPersona(threadId, name);
    this.db
      .prepare(
        `INSERT INTO personas (thread_id, name, content, sources, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(thread_id, name) DO UPDATE SET
           content = excluded.content,
           sources = excluded.sources,
           updated_at = excluded.updated_at`
      )
      .run(threadId, name, content, JSON.stringify(sources), existing?.created_at ?? now, now);
    return {
      thread_id: threadId,
      name,
      content,
      sources,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
  }

  async deletePersona(threadId: string, name: string): Promise<boolean> {
    const info = this.db
      .prepare("DELETE FROM personas WHERE thread_id = ? AND name = ?")
      .run(threadId, name);
    return info.changes > 0;
  }

  // -- Access lists ----------------------------------------------------

  async getAccessList(threadId: string): Promise<AccessListData> {
    const style = await this.getThreadStyle(threadId);
    const rows = this.db
      .prepare("SELECT user_id, list_type FROM access_list WHERE thread_id = ?")
      .all(threadId) as Array<{ user_id: string; list_type: string }>;
    const whitelist: string[] = [];
    const blacklist: string[] = [];
    for (const r of rows) {
      if (r.list_type === "white") whitelist.push(r.user_id);
      else if (r.list_type === "black") blacklist.push(r.user_id);
    }
    return {
      thread_id: threadId,
      access_mode: style.access_mode,
      whitelist,
      blacklist,
      global_blacklist: await this.getGlobalBlacklist(),
    };
  }

  async setAccessMode(threadId: string, mode: "off" | "whitelist" | "blacklist"): Promise<void> {
    await this.setThreadStyle(threadId, { access_mode: mode });
  }

  async addToAccessList(threadId: string, userId: string, listType: "white" | "black"): Promise<void> {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO access_list (thread_id, user_id, list_type, created_at) VALUES (?, ?, ?, ?)"
      )
      .run(threadId, userId, listType, Date.now());
  }

  async removeFromAccessList(threadId: string, userId: string): Promise<void> {
    this.db
      .prepare("DELETE FROM access_list WHERE thread_id = ? AND user_id = ?")
      .run(threadId, userId);
  }

  async getGlobalBlacklist(): Promise<string[]> {
    const rows = this.db
      .prepare("SELECT user_id FROM access_global WHERE list_type = 'black'")
      .all() as Array<{ user_id: string }>;
    return rows.map((r) => r.user_id);
  }

  async addGlobalBlacklist(userId: string): Promise<void> {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO access_global (user_id, list_type, created_at) VALUES (?, 'black', ?)"
      )
      .run(userId, Date.now());
  }

  async removeGlobalBlacklist(userId: string): Promise<void> {
    this.db.prepare("DELETE FROM access_global WHERE user_id = ?").run(userId);
  }

  // -- Messages ----------------------------------------------------------

  async saveMessage(msg: MessageRecord): Promise<void> {
    try {
      this.db
        .prepare(
          "INSERT OR REPLACE INTO messages (id, thread_id, sender_id, sender_name, body, reply_to_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        )
        .run(
          msg.id,
          msg.thread_id,
          msg.sender_id,
          msg.sender_name ?? null,
          msg.body ?? "",
          msg.reply_to_id ?? null,
          msg.created_at
        );
    } catch (err: any) {
      logger.error({ err: err.message, msgId: msg.id }, "Failed to save message to SQLite");
    }
  }

  async getRecentMessages(threadId: string, limit: number = config.historyLimit): Promise<MessageRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT id, thread_id, sender_id, sender_name, body, reply_to_id, created_at
         FROM messages WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`
      )
      .all(threadId, limit) as unknown as MessageRecord[];
    // Chronological order (oldest to newest), like the gateway client.
    return rows.reverse();
  }

  async recordBotMessage(messageId: string, threadId: string): Promise<void> {
    try {
      this.db
        .prepare("INSERT OR IGNORE INTO bot_messages (id, thread_id, created_at) VALUES (?, ?, ?)")
        .run(messageId, threadId, Date.now());
    } catch (err: any) {
      logger.error({ err: err.message, messageId }, "Failed to record bot message");
    }
  }

  async isBotMessage(messageId: string): Promise<boolean> {
    const row = this.db
      .prepare("SELECT id FROM bot_messages WHERE id = ?")
      .get(messageId) as { id: string } | undefined;
    return Boolean(row);
  }

  // -- Self thread -------------------------------------------------------

  async getSelfThreadId(): Promise<string | null> {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = 'self_thread_id'")
      .get() as { value: string } | undefined;
    return row?.value || null;
  }

  async setSelfThreadId(threadId: string): Promise<void> {
    this.db
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('self_thread_id', ?)")
      .run(threadId);
  }

  // -- Typing mode + presence (were local JSON files; now tables) --------

  async getTypingMode(threadId: string): Promise<"user" | "bot"> {
    const row = this.db
      .prepare("SELECT mode FROM typing_modes WHERE thread_id = ?")
      .get(threadId) as { mode: string } | undefined;
    return row?.mode === "user" ? "user" : "bot";
  }

  async setTypingMode(threadId: string, mode: "user" | "bot"): Promise<void> {
    this.db
      .prepare("INSERT OR REPLACE INTO typing_modes (thread_id, mode) VALUES (?, ?)")
      .run(threadId, mode);
  }

  async getPresenceEnabled(): Promise<boolean> {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = 'presence_enabled'")
      .get() as { value: string } | undefined;
    return row?.value !== "0";
  }

  async setPresenceEnabled(enabled: boolean): Promise<void> {
    this.db
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('presence_enabled', ?)")
      .run(enabled ? "1" : "0");
  }

  // -- Maintenance -------------------------------------------------------

  async purgeOldMessages(olderThanTimestamp: number): Promise<{ deletedMessages?: number; deletedBot?: number }> {
    const resMsg = this.db
      .prepare("DELETE FROM messages WHERE created_at < ?")
      .run(olderThanTimestamp);
    const resBot = this.db
      .prepare("DELETE FROM bot_messages WHERE created_at < ?")
      .run(olderThanTimestamp);
    return { deletedMessages: Number(resMsg.changes), deletedBot: Number(resBot.changes) };
  }
}
