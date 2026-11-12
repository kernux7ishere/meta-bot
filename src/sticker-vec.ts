// Semantic sticker memory — stickers described by vision, found by meaning.
//
// How waku-bot does it (and what we take from it): when the owner sends a
// sticker, describe what emotion/mood/meaning it conveys with a vision
// model, embed that description, and store it; when the agent wants a
// sticker for a feeling/situation, embed the query and return the nearest
// sticker by cosine similarity. No manual tagging needed — the sticker
// explains itself.
//
// Differences from waku: no sqlite-vec (our pack is small — a SQLite
// table + brute-force cosine in code is plenty), no TTL/eviction (the pack
// is curated by the owner, not sampled at 50%), and the manual pack
// (sticker-pack.ts, names/emotions/tags) stays as the first lookup —
// semantic search is the fallback when no name/emotion matches. A
// sticker is only described ONCE per thread (re-sends just touch
// lastSeen); stickers without an image URL (animated/video stickers —
// Lightsail has no ffmpeg for a first frame) are learned ID-only in the
// pack, like before, and never enter this store.
//
// Stored in the local SQLite file (bot.db, table sticker_vec) — it used
// to be sticker-vec.json; the storage moved 2026-11-11, the semantics
// did not.

import { getConnection } from "./db/sqlite-conn.js";
import { logger } from "./utils/logger.js";
import { embedText, cosineSimilarity } from "./llm/embeddings.js";
import { readImageTool } from "./tools/read-image.js";

const MAX_PER_THREAD = 200;
/** Minimum cosine similarity for a semantic hit (a wrong-but-close
 *  sticker is less harmful than refusing, so the floor is low). */
export const STICKER_MIN_SIMILARITY = 0.45;

export interface StickerVecRecord {
  /** Numeric sticker id as a string. */
  id: string;
  /** Vision description (Vietnamese, 1-2 sentences). */
  description: string;
  embedding: number[];
  dimensions: number;
  /** Thread it was learned in (search prefers the current thread). */
  threadId: string;
  lastSeen: number;
}

function rowToRecord(row: any): StickerVecRecord {
  let embedding: number[] = [];
  try {
    const parsed = JSON.parse(row.embedding || "[]");
    embedding = Array.isArray(parsed) ? parsed : [];
  } catch {
    embedding = [];
  }
  return {
    id: row.id,
    description: row.description,
    embedding,
    dimensions: row.dimensions,
    threadId: row.thread_id,
    lastSeen: row.last_seen,
  };
}

function readThread(threadId: string): StickerVecRecord[] {
  const db = getConnection();
  const rows = db
    .prepare(
      "SELECT id, description, embedding, dimensions, thread_id, last_seen FROM sticker_vec WHERE thread_id = ? ORDER BY seq"
    )
    .all(threadId) as any[];
  return rows.map(rowToRecord);
}

function readAll(): StickerVecRecord[] {
  const db = getConnection();
  const rows = db
    .prepare(
      "SELECT id, description, embedding, dimensions, thread_id, last_seen FROM sticker_vec ORDER BY seq"
    )
    .all() as any[];
  return rows.map(rowToRecord);
}

/** All described stickers for a thread (newest first). */
export function getDescribedStickers(threadId: string): StickerVecRecord[] {
  return [...readThread(threadId)].reverse();
}

/** One described sticker, if this thread has it. */
export function getDescribedSticker(id: string, threadId: string): StickerVecRecord | null {
  const db = getConnection();
  const row = db
    .prepare(
      "SELECT id, description, embedding, dimensions, thread_id, last_seen FROM sticker_vec WHERE thread_id = ? AND id = ?"
    )
    .get(threadId, id) as any;
  return row ? rowToRecord(row) : null;
}

/** A sticker's vision description, if it was described in any thread. */
export function getStickerDescription(id: string): string | null {
  const db = getConnection();
  const row = db
    .prepare("SELECT description FROM sticker_vec WHERE id = ? ORDER BY seq LIMIT 1")
    .get(id) as { description: string } | undefined;
  return row?.description ?? null;
}

/**
 * Insert or replace a described-sticker record. Replacing deletes +
 * re-inserts, so the record moves to the end (most-recent order), then
 * the 200/thread cap drops the oldest first. Exported for tests and
 * the migration script (scripts/migrate-to-sqlite.ts).
 */
export function upsertDescribedSticker(record: StickerVecRecord): void {
  const db = getConnection();
  db.prepare("DELETE FROM sticker_vec WHERE thread_id = ? AND id = ?").run(record.threadId, record.id);
  db.prepare(
    "INSERT INTO sticker_vec (thread_id, id, description, embedding, dimensions, last_seen) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(
    record.threadId,
    record.id,
    record.description,
    JSON.stringify(record.embedding),
    record.dimensions,
    record.lastSeen
  );
  db.prepare(
    `DELETE FROM sticker_vec WHERE thread_id = ? AND seq NOT IN
     (SELECT seq FROM sticker_vec WHERE thread_id = ? ORDER BY seq DESC LIMIT ?)`
  ).run(record.threadId, record.threadId, MAX_PER_THREAD);
}

/** Remove a sticker's vector entry (e.g. when .sticker deletes it). */
export function deleteDescribedSticker(id: string): void {
  const db = getConnection();
  db.prepare("DELETE FROM sticker_vec WHERE id = ?").run(id);
}

/** Strip the read_image tool's marker wrapper / error prefix. */
export function cleanDescription(raw: string): string {
  return raw
    .replace(/\[UNTRUSTED IMAGE ANALYSIS DATA START\]/g, "")
    .replace(/\[UNTRUSTED IMAGE ANALYSIS DATA END\]/g, "")
    .trim();
}

const DESCRIBE_PROMPT =
  "Mô tả ngắn gọn (1-2 câu, tiếng Việt) sticker này thể hiện cảm xúc, tâm trạng hay ý nghĩa gì. Chỉ trả về mô tả, không thêm gì khác.";

/**
 * Describe a sticker with vision + embed the description, storing it for
 * semantic search. Returns the record, or null when it cannot be
 * described (no vision, download failed, embedding failed). Already
 * described in this thread → just touches lastSeen, no LLM calls.
 * Fire-and-forget from the router: never blocks the reply.
 */
export async function describeAndEmbedSticker(
  id: string,
  imageUrl: string,
  threadId: string
): Promise<StickerVecRecord | null> {
  const existing = getDescribedSticker(id, threadId);
  if (existing) {
    existing.lastSeen = Date.now();
    upsertDescribedSticker(existing);
    return existing;
  }
  try {
    const raw = await readImageTool.execute(
      { url: imageUrl, prompt: DESCRIBE_PROMPT },
      // read_image ignores the context (it only needs the URL + prompt);
      // the tool interface still requires a context object.
      { threadId, senderId: "" }
    );
    const description = cleanDescription(raw).slice(0, 500);
    if (!description || /^(Failed|Error)/i.test(description)) {
      logger.warn({ stickerId: id }, "Sticker vision description failed, learning ID-only");
      return null;
    }
    const embedding = await embedText(description);
    const record: StickerVecRecord = {
      id,
      description,
      embedding,
      dimensions: embedding.length,
      threadId,
      lastSeen: Date.now(),
    };
    upsertDescribedSticker(record);
    logger.info({ stickerId: id, description }, "Sticker described + embedded for semantic search");
    return record;
  } catch (err: any) {
    logger.warn({ err: err.message, stickerId: id }, "Sticker describe/embed failed, learning ID-only");
    return null;
  }
}

export interface StickerSearchHit {
  record: StickerVecRecord;
  similarity: number;
}

/**
 * Find the sticker whose description best matches a feeling/situation.
 * Embeds the query, compares against this thread's stickers first, then
 * all threads if nothing in-thread clears the bar. `embedFn` is
 * injectable so tests can pass a fake embedder (no network).
 */
export async function searchStickerByMeaning(
  query: string,
  threadId: string,
  embedFn: (text: string) => Promise<number[]> = embedText
): Promise<StickerSearchHit | null> {
  const all = readAll();
  if (all.length === 0) return null;
  const inThread = all.filter((r) => r.threadId === threadId);
  const queryVec = await embedFn(query);
  const bestIn = (pool: StickerVecRecord[]): StickerSearchHit | null => {
    let best: StickerSearchHit | null = null;
    for (const record of pool) {
      if (record.dimensions !== queryVec.length) continue;
      const similarity = cosineSimilarity(queryVec, record.embedding);
      if (!best || similarity > best.similarity) best = { record, similarity };
    }
    return best;
  };
  const hit = bestIn(inThread);
  if (hit && hit.similarity >= STICKER_MIN_SIMILARITY) return hit;
  const globalHit = bestIn(all);
  if (globalHit && globalHit.similarity >= STICKER_MIN_SIMILARITY) return globalHit;
  return null;
}
