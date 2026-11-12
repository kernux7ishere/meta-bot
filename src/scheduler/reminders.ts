import { randomUUID } from "node:crypto";
import { getConnection } from "../db/sqlite-conn.js";
import { logger } from "../utils/logger.js";
import type { MessengerClient } from "../messenger/types.js";

// Scheduled reminders ("2 phút nữa ping tôi", "nhắc tôi sau 1 giờ ...").
//
// A reminder is a message the bot sends to a thread at a future time.
// They live in the local SQLite file (bot.db, table reminders) — they
// used to be reminders.json; the storage moved 2026-11-11, the semantics
// did not. Deploy tars never include bot.db, so a deploy never wipes
// pending reminders. On startup the bot restores them and re-arms the
// timers; a reminder whose time already passed while the bot was down
// fires immediately.
//
// Design notes (2026-11-07): this is pragmatic, not optimal. Timers are
// one setTimeout per reminder (precise, non-blocking — other messages
// are answered normally while a timer waits); a polling loop would be
// more robust for very long delays but adds latency. Sends retry 3x
// before a reminder is dropped, so a transient failure does not silently
// lose it. There is no cancel/list agent tool yet —
// cancelReminder/listReminders exist for one to be added.
export interface Reminder {
  id: string;
  threadId: string;
  /** Epoch ms when the reminder fires. */
  fireAt: number;
  /** Message text to send (already contains "@Name" for each mention). */
  text: string;
  /** @mentions to attach (user id + display name, for offset computation). */
  mentions: Array<{ user_id: string; name: string }>;
  /** Who asked for the reminder (for the confirmation text). */
  requesterId: string;
  createdAt: number;
}

/** Max delay the scheduler accepts (14 days). Node's setTimeout caps at
 *  ~24.8d (2^31-1 ms), so 14d stays safely inside it; reminders persist in
 *  bot.db and are re-armed on every restart, so a multi-day
 *  reminder survives bot restarts and deploys. */
export const MAX_REMINDER_DELAY_MS = 14 * 24 * 60 * 60 * 1000;
/** Min delay (10s) — anything shorter is just "send it now". */
export const MIN_REMINDER_DELAY_MS = 10 * 1000;

const timers = new Map<string, NodeJS.Timeout>();

function rowToReminder(row: any): Reminder {
  let mentions: Array<{ user_id: string; name: string }> = [];
  try {
    const parsed = JSON.parse(row.mentions || "[]");
    mentions = Array.isArray(parsed) ? parsed : [];
  } catch {
    mentions = [];
  }
  return {
    id: row.id,
    threadId: row.thread_id,
    fireAt: row.fire_at,
    text: row.text,
    mentions,
    requesterId: row.requester_id,
    createdAt: row.created_at,
  };
}

function readAll(): Reminder[] {
  const db = getConnection();
  const rows = db
    .prepare("SELECT id, thread_id, fire_at, text, mentions, requester_id, created_at FROM reminders")
    .all() as any[];
  return rows.map(rowToReminder);
}

function writeOne(reminder: Reminder): void {
  const db = getConnection();
  db.prepare(
    "INSERT OR REPLACE INTO reminders (id, thread_id, fire_at, text, mentions, requester_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(
    reminder.id,
    reminder.threadId,
    reminder.fireAt,
    reminder.text,
    JSON.stringify(reminder.mentions),
    reminder.requesterId,
    reminder.createdAt
  );
}

function removeStored(id: string): void {
  const db = getConnection();
  db.prepare("DELETE FROM reminders WHERE id = ?").run(id);
}

function armTimer(client: MessengerClient, reminder: Reminder): void {
  const delay = Math.max(0, reminder.fireAt - Date.now());
  const timer = setTimeout(async () => {
    timers.delete(reminder.id);
    // Retry the send (up to 3 attempts, 30s/60s/120s apart). The reminder
    // is only removed from the file AFTER a successful send — removing it
    // before the send meant a transient failure (network, sidecar down)
    // silently lost the reminder and the user was never pinged.
    const msg: any = { body: reminder.text };
    if (reminder.mentions.length > 0) {
      // Go client format: [{user_id, name}] — computeMentionRefs finds
      // "@Name" in the text and builds the offsets from it.
      msg.mentions = reminder.mentions.map((m) => ({
        user_id: m.user_id,
        name: m.name,
      }));
    }
    const backoffs = [0, 30_000, 60_000, 120_000];
    for (let attempt = 0; attempt < backoffs.length; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, backoffs[attempt]));
      }
      try {
        await client.sendMessage(msg, reminder.threadId);
        removeStored(reminder.id);
        logger.info(
          { reminderId: reminder.id, threadId: reminder.threadId, attempt: attempt + 1 },
          "Reminder fired"
        );
        return;
      } catch (err: any) {
        logger.warn(
          { err: err.message, reminderId: reminder.id, threadId: reminder.threadId, attempt: attempt + 1 },
          "Failed to send reminder, will retry"
        );
      }
    }
    // All attempts failed — drop it so it does not retry forever, but log
    // loudly so the failure is visible instead of silent.
    removeStored(reminder.id);
    logger.error(
      { reminderId: reminder.id, threadId: reminder.threadId },
      "Reminder dropped after all send attempts failed"
    );
  }, delay);
  // A pending timer must not keep the process alive on shutdown.
  timer.unref?.();
  timers.set(reminder.id, timer);
}

/** Schedule a reminder (persists it, then arms the timer). Returns it. */
export function scheduleReminder(
  client: MessengerClient,
  input: Omit<Reminder, "id" | "createdAt">
): Reminder {
  const reminder: Reminder = {
    ...input,
    id: randomUUID(),
    createdAt: Date.now(),
  };
  writeOne(reminder);
  armTimer(client, reminder);
  return reminder;
}

/** Cancel a pending reminder by id. Returns true if one was pending. */
export function cancelReminder(id: string): boolean {
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
  const before = readAll().length;
  removeStored(id);
  return readAll().length < before || timer !== undefined;
}

/** Pending reminders for a thread (for listing / cancelling). */
export function listReminders(threadId: string): Reminder[] {
  return readAll()
    .filter((r) => r.threadId === threadId)
    .sort((a, b) => a.fireAt - b.fireAt);
}

/** Restore pending reminders after a (re)start. Overdue ones fire at once. */
export function restoreReminders(client: MessengerClient): void {
  const all = readAll();
  if (all.length === 0) return;
  const now = Date.now();
  for (const reminder of all) {
    if (reminder.fireAt <= now) {
      // Overdue (bot was down): fire immediately via a 0ms timer.
      armTimer(client, { ...reminder, fireAt: now });
    } else {
      armTimer(client, reminder);
    }
  }
  logger.info(
    { count: all.length },
    "Restored pending reminders"
  );
}
