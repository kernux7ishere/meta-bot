// Recent-attachments memory — files/images other people sent in each
// thread, so the agent can answer follow-ups about them.
//
// Why: the agent only ever sees the CURRENT message's attachments. When
// the user sends a file and then asks about it in the NEXT message
// ("đọc file này và tóm tắt", "mô tả nó"), the next turn's context has
// no trace of the file — history is text-only, and the history-based
// recent-media lookup returns [] under the Go client (and only covers
// images anyway, not files). Proven 2026-11-11: the user sent a PDF,
// asked the bot to summarize it in the next message, and the bot
// replied "file đâu, gửi link hoặc đính kèm file đi đã" — because the
// sidecar didn't even surface attachments in message events, and
// nothing recorded them.
//
// Two halves: (1) the sidecar now surfaces attachments in the message
// event (LSInsertAttachment: Filename + PlayableUrl + mime + size);
// (2) this file records every incoming message's attachments per
// thread, and the router injects the most recent few into the agent's
// context, so "file này" resolves to a URL the agent can read_file /
// read_image itself. Never ask the user to resend what was just sent.
//
// Stored in the local SQLite file (bot.db, tables recent_attachments
// and message_links) — it used to be recent-attachments.json +
// recent-message-links.json; the storage moved 2026-11-11, the
// semantics did not. Capped per thread so the store cannot grow without
// bound. Note the URLs are Facebook CDN links: they EXPIRE after a while
// (typically hours), so this is a short-term memory — right for "file
// này" minutes after the send, not for days later. If read_file fails on
// an expired URL, the agent should say so plainly instead of asking for
// a resend of something sent long ago.

import { getConnection } from "./db/sqlite-conn.js";

const MAX_PER_THREAD = 20;

export interface RecentAttachment {
  url: string;
  name?: string;
  /** "photo" | "file" | "video" | "audio" | "sticker" (as the sidecar reports it). */
  type: string;
  mime?: string;
  size?: number;
  senderId: string;
  messageId: string;
  receivedAt: number;
}

/**
 * Reply-chain links: messageId -> the message it replied to, per thread.
 * Why: a user often replies to a REPLY ("Attachment 📎" was itself a
 * reply to the PDF, and "thế còn cái này" replied to that) — resolving
 * only the directly-replied message finds a plain text message with no
 * attachments, so the bot must walk up the chain until it finds the
 * message that actually carries the file/photo/sticker. Same idea as
 * waku-bot's reply-chain walk (up to 10 messages). Links are recorded
 * for every message (any sender, bot echoes included — a chain can pass
 * through a bot message), because the link is about the thread, not the
 * sender. Stored beside the attachments, capped per thread.
 */
const MAX_LINKS_PER_THREAD = 200;
const MAX_CHAIN_DEPTH = 10;

function rowToAttachment(row: any): RecentAttachment {
  return {
    url: row.url,
    name: row.name ?? undefined,
    type: row.type,
    mime: row.mime ?? undefined,
    size: row.size ?? undefined,
    senderId: row.sender_id,
    messageId: row.message_id,
    receivedAt: row.received_at,
  };
}

function readAttachments(threadId: string): RecentAttachment[] {
  const db = getConnection();
  const rows = db
    .prepare(
      "SELECT url, name, type, mime, size, sender_id, message_id, received_at FROM recent_attachments WHERE thread_id = ? ORDER BY seq"
    )
    .all(threadId) as any[];
  return rows.map(rowToAttachment);
}

function readLinks(threadId: string): Record<string, string> {
  const db = getConnection();
  const rows = db
    .prepare("SELECT message_id, reply_to_id FROM message_links WHERE thread_id = ? ORDER BY seq")
    .all(threadId) as Array<{ message_id: string; reply_to_id: string }>;
  const links: Record<string, string> = {};
  for (const r of rows) links[r.message_id] = r.reply_to_id;
  return links;
}

/** Record that `messageId` replied to `replyToId` in this thread. */
export function recordMessageLink(threadId: string, messageId: string, replyToId: string): void {
  if (!messageId || !replyToId || messageId === replyToId) return;
  const db = getConnection();
  const existing = db
    .prepare("SELECT reply_to_id FROM message_links WHERE thread_id = ? AND message_id = ?")
    .get(threadId, messageId) as { reply_to_id: string } | undefined;
  if (existing) {
    if (existing.reply_to_id === replyToId) return;
    // Same link, new target: update in place (keeps its age/position).
    db.prepare("UPDATE message_links SET reply_to_id = ? WHERE thread_id = ? AND message_id = ?").run(
      replyToId,
      threadId,
      messageId
    );
    return;
  }
  db.prepare("INSERT INTO message_links (thread_id, message_id, reply_to_id) VALUES (?, ?, ?)").run(
    threadId,
    messageId,
    replyToId
  );
  // Cap: drop the oldest links first.
  db.prepare(
    `DELETE FROM message_links WHERE thread_id = ? AND seq NOT IN
     (SELECT seq FROM message_links WHERE thread_id = ? ORDER BY seq DESC LIMIT ?)`
  ).run(threadId, threadId, MAX_LINKS_PER_THREAD);
}

/**
 * Walk the reply chain from `startMessageId` (the message being replied
 * to) up to MAX_CHAIN_DEPTH levels, returning the first attachments
 * found. Cycle-safe (a visited set stops loops). Returns [] when no
 * message in the chain carries an attachment — e.g. the file predates
 * this memory (sent before the deploy) or was never recorded.
 */
export function resolveReplyChainAttachments(
  threadId: string,
  startMessageId: string
): RecentAttachment[] {
  const list = readAttachments(threadId);
  const links = readLinks(threadId);
  const seen = new Set<string>();
  let current: string | undefined = startMessageId;
  for (let depth = 0; depth < MAX_CHAIN_DEPTH && current && !seen.has(current); depth++) {
    seen.add(current);
    const found = list.filter((r) => r.messageId === current);
    if (found.length > 0) return found;
    current = links[current];
  }
  return [];
}

export interface IncomingAttachment {
  url?: string;
  name?: string;
  type: string;
  mime?: string;
  size?: number;
}

/** Record one message's attachments (if any) for this thread. */
export function recordAttachments(
  threadId: string,
  attachments: IncomingAttachment[],
  senderId: string,
  messageId: string
): void {
  const usable = (attachments || []).filter((a) => a && (a.url || a.name));
  if (usable.length === 0) return;
  const db = getConnection();
  // One message is recorded once — MQTT redelivery must not duplicate it.
  const already = db
    .prepare("SELECT seq FROM recent_attachments WHERE thread_id = ? AND message_id = ? LIMIT 1")
    .get(threadId, messageId) as { seq: number } | undefined;
  if (already) return;
  const now = Date.now();
  const insert = db.prepare(
    "INSERT INTO recent_attachments (thread_id, message_id, url, name, type, mime, size, sender_id, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  for (const a of usable) {
    insert.run(
      threadId,
      messageId,
      a.url || "",
      a.name ?? null,
      a.type || "file",
      a.mime ?? null,
      a.size ?? null,
      senderId,
      now
    );
  }
  // Cap: drop the oldest attachments first (insertion order).
  db.prepare(
    `DELETE FROM recent_attachments WHERE thread_id = ? AND seq NOT IN
     (SELECT seq FROM recent_attachments WHERE thread_id = ? ORDER BY seq DESC LIMIT ?)`
  ).run(threadId, threadId, MAX_PER_THREAD);
}

/** Most recent attachments others sent in this thread, newest first. */
export function getRecentAttachments(threadId: string, limit = 5): RecentAttachment[] {
  const db = getConnection();
  const rows = db
    .prepare(
      "SELECT url, name, type, mime, size, sender_id, message_id, received_at FROM recent_attachments WHERE thread_id = ? ORDER BY seq DESC LIMIT ?"
    )
    .all(threadId, limit) as any[];
  return rows.map(rowToAttachment);
}

/**
 * Attachments of one specific message (by its id) — used to resolve a
 * reply: the sidecar only sends the replied-to message's id + sender,
 * never its attachments, so "mô tả cái này" as a reply to a photo/file
 * would otherwise see nothing. The message itself was recorded when it
 * arrived, so the lookup hits.
 */
export function getAttachmentsByMessageId(threadId: string, messageId: string): RecentAttachment[] {
  const db = getConnection();
  const rows = db
    .prepare(
      "SELECT url, name, type, mime, size, sender_id, message_id, received_at FROM recent_attachments WHERE thread_id = ? AND message_id = ? ORDER BY seq"
    )
    .all(threadId, messageId) as any[];
  return rows.map(rowToAttachment);
}
