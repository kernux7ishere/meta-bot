// Sent-image tracking — which images the bot already sent, per thread,
// and what they were, so the agent can answer follow-ups about them.
//
// Why: send_image searches Wikimedia Commons and picks a result by index
// (default 0). The agent has no memory of which image it already sent, so
// "ảnh khác" (another photo) re-sent the same file — proven 2026-11-07:
// three "Firefly cosplay" sends were 20240511a.jpg, then 20240511b.jpg,
// then 20240511b.jpg AGAIN (the a/b pair are near-duplicates from one
// photoshoot, so the user saw "the same photo" three times). The fix is
// here, in the tool: before picking a search result, filter out every URL
// already sent in this thread, so "another" always means a different file.
//
// And the second half, added 2026-11-11: the agent ALSO needs to know what
// it sent, or the next turn can't answer "mô tả nó" (describe it). The
// tool result ("Đã gửi ảnh ...") lives only in that turn's LLM context —
// the next turn's history (D1, text only) has no trace of the image, and
// the recent-media lookup reads thread history, which the Go client can't
// return (getThreadHistory is []). So the user asked the bot to describe
// the picture it had just sent, and the bot asked THEM to resend the link.
// Now send_image records the URL + search query + title, and the router
// injects the most recent sent images into the agent's context
// (getRecentSentImages), so "nó" / "ảnh vừa gửi" resolves to a URL the
// agent can read_image itself. Never ask the user to resend what the bot
// already sent.
//
// Stored in the local SQLite file (bot.db, table sent_images) — it used
// to be sent-images.json; the storage moved 2026-11-11, the semantics
// did not. URLs are normalized (query string stripped) so the same file
// under a different tracking query still counts as sent. Capped per
// thread so the store cannot grow without bound. Older files stored plain
// URL strings; they are migrated to records by the migration script
// (scripts/migrate-to-sqlite.ts), not on read anymore.

import { getConnection } from "./db/sqlite-conn.js";

const MAX_PER_THREAD = 200;

export interface SentImageRecord {
  url: string;
  /** The search query that found this image, if it came from a search. */
  query?: string;
  /** Commons title, if known. */
  title?: string;
  sentAt: number;
}

/** Strip the query string (tracking params) for dedup comparison. */
export function normalizeImageUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.split("?")[0];
  }
}

function rowToRecord(row: any): SentImageRecord {
  return {
    url: row.url,
    query: row.query ?? undefined,
    title: row.title ?? undefined,
    sentAt: row.sent_at,
  };
}

function enforceCap(threadId: string): void {
  const db = getConnection();
  db.prepare(
    `DELETE FROM sent_images WHERE thread_id = ? AND seq NOT IN
     (SELECT seq FROM sent_images WHERE thread_id = ? ORDER BY seq DESC LIMIT ?)`
  ).run(threadId, threadId, MAX_PER_THREAD);
}

/** URLs already sent in this thread (normalized). */
export function getSentImageUrls(threadId: string): string[] {
  const db = getConnection();
  const rows = db
    .prepare("SELECT url FROM sent_images WHERE thread_id = ? ORDER BY seq")
    .all(threadId) as Array<{ url: string }>;
  return rows.map((r) => normalizeImageUrl(r.url));
}

/** Most recent images the bot sent in this thread, newest first. */
export function getRecentSentImages(threadId: string, limit = 3): SentImageRecord[] {
  const db = getConnection();
  const rows = db
    .prepare(
      "SELECT url, query, title, sent_at FROM sent_images WHERE thread_id = ? ORDER BY seq DESC LIMIT ?"
    )
    .all(threadId, limit) as any[];
  return rows.map(rowToRecord);
}

/** Record that an image URL was sent in this thread (with its context). */
export function recordSentImage(
  threadId: string,
  url: string,
  meta?: { query?: string; title?: string }
): void {
  const db = getConnection();
  const norm = normalizeImageUrl(url);
  // Re-sent (or re-recorded): delete + re-insert so it moves to the end
  // and "most recent" stays true, instead of growing a duplicate.
  db.prepare("DELETE FROM sent_images WHERE thread_id = ? AND url_norm = ?").run(threadId, norm);
  db.prepare(
    "INSERT INTO sent_images (thread_id, url, url_norm, query, title, sent_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(threadId, url, norm, meta?.query ?? null, meta?.title ?? null, Date.now());
  enforceCap(threadId);
}

/** True when this URL was already sent in this thread. */
export function wasImageSent(threadId: string, url: string): boolean {
  const db = getConnection();
  const row = db
    .prepare("SELECT seq FROM sent_images WHERE thread_id = ? AND url_norm = ?")
    .get(threadId, normalizeImageUrl(url)) as { seq: number } | undefined;
  return Boolean(row);
}
