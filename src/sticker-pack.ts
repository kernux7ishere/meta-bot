// Sticker pack — the bot's known stickers, learned from the owner.
//
// A sticker entry is { id, name, label, emotion }: the agent sends a
// sticker by name ("like") or by emotion ("agree"), and the pack resolves
// it to a numeric sticker id. The pack lives in the local SQLite file
// (bot.db, table sticker_pack) — it used to be sticker-pack.json; the
// storage moved 2026-11-11, the semantics did not.
//
// The pack starts with Facebook's default Like stickers and GROWS: every
// sticker the owner sends (in any thread, or in the sticker-learning
// group) is recorded here with the surrounding text as its context, so
// the agent learns which sticker the owner uses for which feeling —
// that is the "learn from the user" behaviour, not a forced
// sticker-for-sticker reply.

import { getConnection } from "./db/sqlite-conn.js";

export interface StickerEntry {
  /** Numeric sticker id as a string. */
  id: string;
  /** Shortcut name the agent uses (lowercase, e.g. "like"). */
  name: string;
  /** Human label, e.g. "Like (vừa)". */
  label: string;
  /** Emotion/context tag, e.g. "agree" — the agent picks by this. */
  emotion: string;
  /** Where it came from: "builtin" or the thread it was learned in. */
  source: string;
  /** Text sent around it when learned ("" for builtins). */
  context?: string;
  learnedAt: number;
}

function rowToEntry(row: any): StickerEntry {
  return {
    id: row.id,
    name: row.name,
    label: row.label,
    emotion: row.emotion,
    source: row.source,
    context: row.context ?? undefined,
    learnedAt: row.learned_at,
  };
}

function readAll(): StickerEntry[] {
  const db = getConnection();
  const rows = db
    .prepare("SELECT id, name, label, emotion, source, context, learned_at FROM sticker_pack ORDER BY seq")
    .all() as any[];
  return rows.map(rowToEntry);
}

/** Look a sticker up by shortcut name or emotion. Returns the entry or null. */
export function getSticker(query: string): StickerEntry | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const db = getConnection();
  const byName = db
    .prepare("SELECT id, name, label, emotion, source, context, learned_at FROM sticker_pack WHERE LOWER(name) = ? ORDER BY seq LIMIT 1")
    .get(q) as any;
  if (byName) return rowToEntry(byName);
  const byEmotion = db
    .prepare("SELECT id, name, label, emotion, source, context, learned_at FROM sticker_pack WHERE LOWER(emotion) = ? ORDER BY seq LIMIT 1")
    .get(q) as any;
  return byEmotion ? rowToEntry(byEmotion) : null;
}

/** All known stickers, builtins first. */
export function listStickers(): StickerEntry[] {
  return readAll();
}

/**
 * Record a sticker the owner sent. Returns the entry (new or existing).
 * `context` is the text around it (the message it replied to / the text
 * sent with it) so the agent knows when the owner uses it. A sticker
 * already known keeps its name/emotion — learning never renames one.
 */
export function learnSticker(
  id: string,
  context: string,
  sourceThreadId: string
): StickerEntry {
  const db = getConnection();
  const existing = db
    .prepare("SELECT id, name, label, emotion, source, context, learned_at FROM sticker_pack WHERE id = ?")
    .get(id) as any;
  if (existing) {
    if (context && !existing.context) {
      db.prepare("UPDATE sticker_pack SET context = ? WHERE id = ?").run(context.slice(0, 200), id);
      existing.context = context.slice(0, 200);
    }
    return rowToEntry(existing);
  }
  const nRow = db
    .prepare("SELECT COUNT(*) AS n FROM sticker_pack WHERE source != 'builtin'")
    .get() as { n: number };
  const n = nRow.n + 1;
  const entry: StickerEntry = {
    id,
    name: `learned_${n}`,
    label: `Sticker ${n} (học từ bạn)`,
    emotion: "learned",
    source: sourceThreadId,
    context: context.slice(0, 200),
    learnedAt: Date.now(),
  };
  db.prepare(
    "INSERT INTO sticker_pack (id, name, label, emotion, source, context, learned_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(entry.id, entry.name, entry.label, entry.emotion, entry.source, entry.context ?? null, entry.learnedAt);
  return entry;
}

/** Rename / re-tag a learned sticker (owner-driven, via the agent). */
export function tagSticker(
  id: string,
  patch: { name?: string; emotion?: string; label?: string }
): StickerEntry | null {
  const db = getConnection();
  const entry = db
    .prepare("SELECT id, name, label, emotion, source, context, learned_at FROM sticker_pack WHERE id = ?")
    .get(id) as any;
  if (!entry || entry.source === "builtin") return null;
  if (patch.name) entry.name = patch.name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  if (patch.emotion) entry.emotion = patch.emotion.trim().toLowerCase();
  if (patch.label) entry.label = patch.label;
  db.prepare("UPDATE sticker_pack SET name = ?, emotion = ?, label = ? WHERE id = ?").run(
    entry.name,
    entry.emotion,
    entry.label,
    id
  );
  return rowToEntry(entry);
}
