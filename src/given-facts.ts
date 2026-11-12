// Given-fact tracking — which facts/trivia the bot already gave, per
// thread, so it never repeats one.
//
// Why: 2026-11-12 the bot gave the SAME honey fact twice (23:22 Pong
// reply, then again 06:57 "fact mới toanh" — the user: "cái này hôm
// qua nói rồi mà"). The agent records the daily-fact REQUEST via
// `remember`, but nothing recorded the facts themselves, and the raw
// conversation history (last 20 messages) was not enough — the agent
// had the earlier fact in history and still re-gave it, reworded.
// The fix is two halves, in this module + the prompt:
//   1. record — the agent calls the `record_fact` tool with every fact
//      it gives (see src/tools/record-fact.ts);
//   2. recall — the router injects the most recent given facts into the
//      agent's context (gatherAgentContext), and the system prompt tells
//      it to check that list first and pick a different fact. The LLM
//      itself judges rewordings — exact-match dedup here would NOT
//      catch them (the two honey wordings differ in words, not just
//      punctuation), so `fact_norm` dedup is only storage hygiene.
//
// Stored in the local SQLite file (bot.db, table given_facts), capped
// at 200 per thread, oldest dropped first.

import { getConnection } from "./db/sqlite-conn.js";

const MAX_PER_THREAD = 200;
export const GIVEN_FACTS_LIMIT = 10;

/** Normalize for dedup: lowercase, strip punctuation, collapse space. */
export function normalizeFact(fact: string): string {
  return fact
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

/**
 * Record a fact the bot just gave in this thread. Returns true when it
 * is new, false when an equivalent (normalized) fact was already
 * recorded. Never throws — callers must not fail a reply over this.
 */
export function recordGivenFact(threadId: string, fact: string): boolean {
  const text = fact.trim();
  if (!text) return false;
  const norm = normalizeFact(text);
  if (!norm) return false;
  try {
    const db = getConnection();
    const r = db
      .prepare(
        "INSERT OR IGNORE INTO given_facts (thread_id, fact, fact_norm, given_at) VALUES (?, ?, ?, ?)"
      )
      .run(threadId, text, norm, Date.now());
    if (r.changes === 0) return false;
    // Cap: keep the newest MAX_PER_THREAD rows per thread.
    db.prepare(
      `DELETE FROM given_facts WHERE thread_id = ? AND seq NOT IN
       (SELECT seq FROM given_facts WHERE thread_id = ? ORDER BY seq DESC LIMIT ?)`
    ).run(threadId, threadId, MAX_PER_THREAD);
    return true;
  } catch {
    return false;
  }
}

/** The most recent facts given in this thread, newest first. */
export function getRecentGivenFacts(threadId: string, limit = GIVEN_FACTS_LIMIT): string[] {
  const db = getConnection();
  const rows = db
    .prepare(
      "SELECT fact FROM given_facts WHERE thread_id = ? ORDER BY seq DESC LIMIT ?"
    )
    .all(threadId, limit) as any[];
  return rows.map((r) => r.fact as string);
}
