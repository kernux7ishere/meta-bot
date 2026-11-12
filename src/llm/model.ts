import dotenv from "dotenv";
import { fetchWithTimeout } from "../utils/fetch-timeout.js";
import { getConnection } from "../db/sqlite-conn.js";

// NOTE: this module must NOT import logger or config — config.ts imports
// this module (for the `model` getter), and logger imports config, so
// importing either here would create a circular import that breaks startup
// ("Cannot access 'config' before initialization"). The SQLite helper
// (db/sqlite-conn.ts) is dependency-free, so importing it is safe.

dotenv.config();

// Runtime-switchable LLM model (`.model` command). The model is global
// (all threads) — it replaces the LLM_MODEL env default at runtime and
// persists in the local SQLite file (bot.db, settings table) so it
// survives restarts. It used to be llm-model.json; the storage moved
// 2026-11-11, the semantics did not. Deploy tars never include bot.db.
// `config.llm.model` is a getter that reads this module, so every LLM
// call site picks up a switch without code changes.

export function getModelDefault(): string {
  return process.env.LLM_MODEL || "gpt-4o";
}

function readStored(): string | null {
  try {
    const db = getConnection();
    const row = db.prepare("SELECT value FROM settings WHERE key = 'llm_model'").get() as
      | { value: string }
      | undefined;
    const name = row?.value;
    return typeof name === "string" && name.trim().length > 0 ? name.trim() : null;
  } catch {
    // DB unavailable (e.g. tests that never opened it) — fall back to
    // the env default instead of crashing startup.
    return null;
  }
}

let currentModel: string | null = null;

/** Current model: stored override if set, else the LLM_MODEL env default. */
export function getCurrentModel(): string {
  if (currentModel === null) {
    currentModel = readStored() || getModelDefault();
  }
  return currentModel;
}

/** Switch the model now and persist it. Empty name resets to the default. */
export function setCurrentModel(name: string): string {
  const next = name.trim().length > 0 ? name.trim() : getModelDefault();
  currentModel = next;
  try {
    const db = getConnection();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('llm_model', ?)").run(next);
  } catch (err: any) {
    console.warn("Failed to persist the model choice:", err?.message);
  }
  return next;
}

export function resetModel(): string {
  try {
    const db = getConnection();
    db.prepare("DELETE FROM settings WHERE key = 'llm_model'").run();
  } catch {
    // No stored row — already at default.
  }
  currentModel = getModelDefault();
  return currentModel;
}

export interface ModelInfo {
  id: string;
}

/** Provider prefix of a model id (`gemini/gemini-2.0-flash` → `gemini`). */
export function modelProvider(id: string): string {
  const slash = id.indexOf("/");
  return slash > 0 ? id.slice(0, slash) : "khác";
}

/** Fetch every model id the provider advertises (OmniRoute /v1/models).
 *  No cap, no filtering — callers decide what to show. */
export async function fetchAllModelIds(): Promise<string[]> {
  const baseUrl = (process.env.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const apiKey = process.env.LLM_API_KEY || "";
  const res = await fetchWithTimeout(
    `${baseUrl}/models`,
    { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} },
    20_000
  );
  if (!res.ok) {
    throw new Error(`Không lấy được danh sách model (HTTP ${res.status}).`);
  }
  const data: any = await res.json();
  return Array.isArray(data?.data)
    ? data.data.map((m: any) => String(m?.id || "")).filter(Boolean)
    : [];
}

/** Search models by a general name (`.model list gemini` → every model
 *  whose id contains "gemini", across providers). Case-insensitive
 *  substring match. Returns the first 30 matches plus the total count so
 *  the caller can say when the list is truncated. */
export async function listModels(query?: string): Promise<{ models: ModelInfo[]; total: number }> {
  const ids = await fetchAllModelIds();
  const q = (query || "").trim().toLowerCase();
  const filtered = q ? ids.filter((id) => id.toLowerCase().includes(q)) : ids;
  return {
    models: filtered.slice(0, 30).map((id) => ({ id })),
    total: filtered.length,
  };
}
