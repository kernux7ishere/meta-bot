// Text embeddings via OmniRoute /v1/embeddings — used for semantic
// sticker search (embed a sticker's vision description, embed the query,
// pick the closest sticker by cosine similarity). Verified 2026-11-06
// that /v1/embeddings works with gemini/gemini-embedding-001 through
// OmniRoute (the meta-bot key allows gemini/*).
//
// Live quirk (verified 2026-11-11): the `dimensions` parameter is
// REJECTED upstream — OmniRoute translates it to Gemini's
// `outputDimensionality`, which this model endpoint does not accept
// ("Unknown name outputDimensionality"). So no dimensions are requested;
// the model returns its native width (3072) and records store their own
// `dimensions` — search only compares vectors of the same width.

import { getLlmClient } from "./client.js";

/** Embedding model (override with LLM_EMBEDDING_MODEL). */
export const EMBEDDING_MODEL =
  process.env.LLM_EMBEDDING_MODEL || "gemini/gemini-embedding-001";

/** Embed one short text, returning the vector (native model width). */
export async function embedText(text: string): Promise<number[]> {
  const trimmed = text.trim().slice(0, 2000);
  if (!trimmed) throw new Error("Cannot embed empty text");
  const client = getLlmClient();
  const res = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: trimmed,
  });
  const vec = res.data?.[0]?.embedding;
  if (!vec || vec.length === 0) throw new Error("Embedding returned no vector");
  return [...vec];
}

/** Cosine similarity in [-1, 1]; 0 when either vector is empty/zero. */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
