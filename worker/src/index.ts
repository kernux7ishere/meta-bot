/**
 * Cloudflare Worker: D1 Gateway for Messenger AI Userbot
 *
 * Endpoints:
 * - GET  /thread/:threadId            -> Get thread status (ai_enabled)
 * - POST /thread/:threadId            -> Set thread status { ai_enabled: boolean }
 * - GET  /memory/:threadId            -> Get memory content
 * - POST /memory/:threadId            -> Set memory content { content: string }
 * - POST /messages                    -> Save message { id, thread_id, sender_id, sender_name, body, reply_to_id, created_at }
 * - GET  /messages/:threadId?limit=20 -> Get latest messages in thread
 * - GET  /style/:threadId             -> Get thread style { thread_id, content, auto_learn, owner_msgs_since_learn, access_mode, sources, updated_at }
 * - POST /style/:threadId             -> Set thread style { content?, auto_learn?, owner_msgs_since_learn?, access_mode?, sources? }
 * - GET  /access/global                -> Get global blacklist { blacklist: string[] }
 * - POST /access/global               -> Ban/unban globally { action: 'ban'|'unban', user_id: string }
 * - GET  /access/:threadId            -> Get access lists { thread_id, access_mode, whitelist: string[], blacklist: string[], global_blacklist: string[] }
 * - POST /access/:threadId            -> Add/remove/set { action: 'mode'|'add'|'remove', mode?: string, user_id?: string, list_type?: 'white'|'black' }
 * - POST /bot-messages                -> Register bot sent message { id, thread_id, created_at }
 * - GET  /bot-messages/:id            -> Check if a message id was sent by the bot
 * - POST /purge                       -> Purge messages older than timestamp { older_than: number }
 */

export interface Env {
  DB: D1Database;
  GATEWAY_TOKEN: string;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

interface D1PreparedStatement {
  bind(...values: any[]): D1PreparedStatement;
  first<T = any>(colName?: string): Promise<T | null>;
  run(): Promise<{ success: boolean; meta?: any }>;
  all<T = any>(): Promise<{ results: T[]; success: boolean }>;
}

function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
    },
  });
}

function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
        },
      });
    }

    const authHeader = request.headers.get("Authorization");
    const token = authHeader?.replace(/^Bearer\s+/i, "");

    if (!token || token !== env.GATEWAY_TOKEN) {
      return errorResponse("Unauthorized", 401);
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      // 1. Thread settings: /thread/:threadId
      if (path.startsWith("/thread/")) {
        const threadId = decodeURIComponent(path.slice("/thread/".length));
        if (!threadId) return errorResponse("Thread ID is required");

        if (method === "GET") {
          const row = await env.DB.prepare(
            "SELECT thread_id, ai_enabled, updated_at FROM threads WHERE thread_id = ?"
          )
            .bind(threadId)
            .first<{ thread_id: string; ai_enabled: number; updated_at: number }>();

          return jsonResponse({
            thread_id: threadId,
            ai_enabled: row ? Boolean(row.ai_enabled) : false,
            updated_at: row?.updated_at || null,
          });
        }

        if (method === "POST") {
          const body = (await request.json()) as { ai_enabled: boolean };
          const enabledInt = body.ai_enabled ? 1 : 0;
          const now = Date.now();

          await env.DB.prepare(`
            INSERT INTO threads (thread_id, ai_enabled, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(thread_id) DO UPDATE SET
              ai_enabled = excluded.ai_enabled,
              updated_at = excluded.updated_at
          `)
            .bind(threadId, enabledInt, now)
            .run();

          return jsonResponse({ success: true, thread_id: threadId, ai_enabled: Boolean(enabledInt), updated_at: now });
        }
      }

      // 2. Memory: /memory/:threadId
      if (path.startsWith("/memory/")) {
        const threadId = decodeURIComponent(path.slice("/memory/".length));
        if (!threadId) return errorResponse("Thread ID is required");

        if (method === "GET") {
          const row = await env.DB.prepare(
            "SELECT thread_id, content, updated_at FROM memory WHERE thread_id = ?"
          )
            .bind(threadId)
            .first<{ thread_id: string; content: string; updated_at: number }>();

          return jsonResponse({
            thread_id: threadId,
            content: row ? row.content : "",
            updated_at: row?.updated_at || null,
          });
        }

        if (method === "POST") {
          const body = (await request.json()) as { content: string };
          const content = String(body.content || "");
          const now = Date.now();

          await env.DB.prepare(`
            INSERT INTO memory (thread_id, content, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(thread_id) DO UPDATE SET
              content = excluded.content,
              updated_at = excluded.updated_at
          `)
            .bind(threadId, content, now)
            .run();

          return jsonResponse({ success: true, thread_id: threadId, content, updated_at: now });
        }
      }

      // 3. Message store: /messages
      if (path === "/messages" && method === "POST") {
        const body = (await request.json()) as {
          id: string;
          thread_id: string;
          sender_id: string;
          sender_name?: string;
          body?: string;
          reply_to_id?: string;
          created_at?: number;
        };

        if (!body.id || !body.thread_id || !body.sender_id) {
          return errorResponse("Missing required message fields");
        }

        const createdAt = body.created_at || Date.now();

        await env.DB.prepare(`
          INSERT OR REPLACE INTO messages (id, thread_id, sender_id, sender_name, body, reply_to_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
          .bind(
            body.id,
            body.thread_id,
            body.sender_id,
            body.sender_name || null,
            body.body || "",
            body.reply_to_id || null,
            createdAt
          )
          .run();

        return jsonResponse({ success: true, id: body.id });
      }

      // 4. Message query: /messages/:threadId
      if (path.startsWith("/messages/") && method === "GET") {
        const threadId = decodeURIComponent(path.slice("/messages/".length));
        if (!threadId) return errorResponse("Thread ID is required");

        const limitParam = parseInt(url.searchParams.get("limit") || "20", 10);
        const limit = Math.min(Math.max(1, limitParam), 200);

        const rows = await env.DB.prepare(`
          SELECT id, thread_id, sender_id, sender_name, body, reply_to_id, created_at
          FROM messages
          WHERE thread_id = ?
          ORDER BY created_at DESC
          LIMIT ?
        `)
          .bind(threadId, limit)
          .all();

        // Return chronological order (oldest to newest)
        const messages = (rows.results || []).reverse();
        return jsonResponse({ messages });
      }

      // 4.5. Thread Style: /style/:threadId
      if (path.startsWith("/style/")) {
        const threadId = decodeURIComponent(path.slice("/style/".length));
        if (!threadId) return errorResponse("Thread ID is required");

        if (method === "GET") {
          const row = await env.DB.prepare(
            "SELECT thread_id, content, auto_learn, owner_msgs_since_learn, access_mode, sources, updated_at FROM thread_style WHERE thread_id = ?"
          )
            .bind(threadId)
            .first<{
              thread_id: string;
              content: string;
              auto_learn: number;
              owner_msgs_since_learn: number;
              access_mode: string;
              sources: string;
              updated_at: number;
            }>();

          let parsedSources: string[] = [];
          try {
            parsedSources = row?.sources ? JSON.parse(row.sources) : [];
          } catch {
            parsedSources = [];
          }

          return jsonResponse({
            thread_id: threadId,
            content: row ? row.content : "",
            auto_learn: row ? Boolean(row.auto_learn) : false,
            owner_msgs_since_learn: row ? row.owner_msgs_since_learn : 0,
            access_mode: row?.access_mode || "off",
            sources: parsedSources,
            updated_at: row?.updated_at || null,
          });
        }

        if (method === "POST") {
          const body = (await request.json()) as {
            content?: string;
            auto_learn?: boolean;
            owner_msgs_since_learn?: number;
            access_mode?: "off" | "whitelist" | "blacklist";
            sources?: string[];
          };

          const now = Date.now();

          // Fetch existing row first if present to allow partial updates
          const existing = await env.DB.prepare(
            "SELECT content, auto_learn, owner_msgs_since_learn, access_mode, sources FROM thread_style WHERE thread_id = ?"
          )
            .bind(threadId)
            .first<{ content: string; auto_learn: number; owner_msgs_since_learn: number; access_mode: string; sources: string }>();

          const newContent = body.content !== undefined ? String(body.content) : existing?.content || "";
          const newAutoLearn =
            body.auto_learn !== undefined ? (body.auto_learn ? 1 : 0) : existing?.auto_learn || 0;
          const newCounter =
            body.owner_msgs_since_learn !== undefined
              ? body.owner_msgs_since_learn
              : existing?.owner_msgs_since_learn || 0;
          const newAccessMode = body.access_mode !== undefined ? body.access_mode : existing?.access_mode || "off";
          const newSources =
            body.sources !== undefined
              ? JSON.stringify(body.sources)
              : existing?.sources || "[]";

          await env.DB.prepare(`
            INSERT INTO thread_style (thread_id, content, auto_learn, owner_msgs_since_learn, access_mode, sources, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(thread_id) DO UPDATE SET
              content = excluded.content,
              auto_learn = excluded.auto_learn,
              owner_msgs_since_learn = excluded.owner_msgs_since_learn,
              access_mode = excluded.access_mode,
              sources = excluded.sources,
              updated_at = excluded.updated_at
          `)
            .bind(threadId, newContent, newAutoLearn, newCounter, newAccessMode, newSources, now)
            .run();

          let parsedReturnSources: string[] = [];
          try {
            parsedReturnSources = JSON.parse(newSources);
          } catch {
            parsedReturnSources = [];
          }

          return jsonResponse({
            success: true,
            thread_id: threadId,
            content: newContent,
            auto_learn: Boolean(newAutoLearn),
            owner_msgs_since_learn: newCounter,
            access_mode: newAccessMode,
            sources: parsedReturnSources,
            updated_at: now,
          });
        }
      }

      // 4.6. Access List: Global and Per-thread
      if (path === "/access/global") {
        if (method === "GET") {
          const rows = await env.DB.prepare(
            "SELECT user_id FROM access_global WHERE list_type = 'black'"
          ).all<{ user_id: string }>();
          const blacklist = (rows.results || []).map((r) => r.user_id);
          return jsonResponse({ blacklist });
        }

        if (method === "POST") {
          const body = (await request.json()) as {
            action: "ban" | "unban";
            user_id: string;
          };

          if (!body.user_id) {
            return errorResponse("user_id is required");
          }

          const now = Date.now();
          if (body.action === "ban") {
            await env.DB.prepare(`
              INSERT OR REPLACE INTO access_global (user_id, list_type, created_at)
              VALUES (?, 'black', ?)
            `)
              .bind(body.user_id, now)
              .run();

            return jsonResponse({ success: true, user_id: body.user_id, banned: true });
          }

          if (body.action === "unban") {
            await env.DB.prepare("DELETE FROM access_global WHERE user_id = ?")
              .bind(body.user_id)
              .run();

            return jsonResponse({ success: true, user_id: body.user_id, banned: false });
          }

          return errorResponse("Invalid action");
        }
      }

      if (path.startsWith("/access/")) {
        const threadId = decodeURIComponent(path.slice("/access/".length));
        if (!threadId) return errorResponse("Thread ID is required");

        if (method === "GET") {
          const styleRow = await env.DB.prepare(
            "SELECT access_mode FROM thread_style WHERE thread_id = ?"
          )
            .bind(threadId)
            .first<{ access_mode: string }>();

          const rows = await env.DB.prepare(
            "SELECT user_id, list_type FROM access_list WHERE thread_id = ?"
          )
            .bind(threadId)
            .all<{ user_id: string; list_type: string }>();

          const globalRows = await env.DB.prepare(
            "SELECT user_id FROM access_global WHERE list_type = 'black'"
          ).all<{ user_id: string }>();

          const whitelist: string[] = [];
          const blacklist: string[] = [];

          for (const item of rows.results || []) {
            if (item.list_type === "white") whitelist.push(item.user_id);
            else if (item.list_type === "black") blacklist.push(item.user_id);
          }

          const globalBlacklist = (globalRows.results || []).map((r) => r.user_id);

          return jsonResponse({
            thread_id: threadId,
            access_mode: styleRow?.access_mode || "off",
            whitelist,
            blacklist,
            global_blacklist: globalBlacklist,
          });
        }

        if (method === "POST") {
          const body = (await request.json()) as {
            action: "mode" | "add" | "remove";
            mode?: "off" | "whitelist" | "blacklist";
            user_id?: string;
            list_type?: "white" | "black";
          };

          if (body.action === "mode") {
            if (!body.mode || !["off", "whitelist", "blacklist"].includes(body.mode)) {
              return errorResponse("Invalid access mode");
            }
            const now = Date.now();
            await env.DB.prepare(`
              INSERT INTO thread_style (thread_id, access_mode, updated_at)
              VALUES (?, ?, ?)
              ON CONFLICT(thread_id) DO UPDATE SET
                access_mode = excluded.access_mode,
                updated_at = excluded.updated_at
            `)
              .bind(threadId, body.mode, now)
              .run();

            return jsonResponse({ success: true, thread_id: threadId, access_mode: body.mode });
          }

          if (body.action === "add") {
            if (!body.user_id || !body.list_type) {
              return errorResponse("user_id and list_type are required");
            }
            const now = Date.now();
            await env.DB.prepare(`
              INSERT OR REPLACE INTO access_list (thread_id, user_id, list_type, created_at)
              VALUES (?, ?, ?, ?)
            `)
              .bind(threadId, body.user_id, body.list_type, now)
              .run();

            return jsonResponse({ success: true, thread_id: threadId, user_id: body.user_id, list_type: body.list_type });
          }

          if (body.action === "remove") {
            if (!body.user_id) {
              return errorResponse("user_id is required");
            }
            await env.DB.prepare(
              "DELETE FROM access_list WHERE thread_id = ? AND user_id = ?"
            )
              .bind(threadId, body.user_id)
              .run();

            return jsonResponse({ success: true, thread_id: threadId, user_id: body.user_id });
          }

          return errorResponse("Invalid action");
        }
      }

      // 5. Bot messages tracking: /bot-messages
      if (path === "/bot-messages" && method === "POST") {
        const body = (await request.json()) as {
          id: string;
          thread_id: string;
          created_at?: number;
        };

        if (!body.id || !body.thread_id) {
          return errorResponse("Missing required bot message fields");
        }

        const createdAt = body.created_at || Date.now();

        await env.DB.prepare(`
          INSERT OR IGNORE INTO bot_messages (id, thread_id, created_at)
          VALUES (?, ?, ?)
        `)
          .bind(body.id, body.thread_id, createdAt)
          .run();

        return jsonResponse({ success: true, id: body.id });
      }

      // Check if message was sent by bot: /bot-messages/:id
      if (path.startsWith("/bot-messages/") && method === "GET") {
        const id = decodeURIComponent(path.slice("/bot-messages/".length));
        if (!id) return errorResponse("Message ID is required");

        const row = await env.DB.prepare(
          "SELECT id, thread_id, created_at FROM bot_messages WHERE id = ?"
        )
          .bind(id)
          .first();

        return jsonResponse({ is_bot: Boolean(row), message: row || null });
      }

      // 6. Purge old records: /purge
      if (path === "/purge" && method === "POST") {
        const body = (await request.json()) as { older_than: number };
        if (!body.older_than) return errorResponse("older_than timestamp required");

        const resMsg = await env.DB.prepare("DELETE FROM messages WHERE created_at < ?")
          .bind(body.older_than)
          .run();

        const resBot = await env.DB.prepare("DELETE FROM bot_messages WHERE created_at < ?")
          .bind(body.older_than)
          .run();

        return jsonResponse({ success: true, deleted_messages: resMsg.meta, deleted_bot: resBot.meta });
      }

      return errorResponse("Endpoint not found", 404);
    } catch (err: any) {
      return jsonResponse({ error: err.message || "Internal server error" }, 500);
    }
  },
};
