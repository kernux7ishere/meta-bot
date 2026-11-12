import dotenv from "dotenv";
import path from "node:path";
import { getCurrentModel } from "./llm/model.js";

dotenv.config();

function getEnv(key: string, defaultValue = ""): string {
  return process.env[key] || defaultValue;
}

function getEnvNumber(key: string, defaultValue: number): number {
  const val = process.env[key];
  if (!val) return defaultValue;
  const num = Number(val);
  return isNaN(num) ? defaultValue : num;
}

function getEnvBoolean(key: string, defaultValue: boolean): boolean {
  const val = process.env[key];
  if (val === undefined) return defaultValue;
  return val.toLowerCase() === "true" || val === "1";
}

export const config = {
  // Owner & Appstate
  ownerId: getEnv("OWNER_ID", ""),
  appstatePath: path.resolve(process.cwd(), getEnv("APPSTATE_PATH", "./appstate.json")),

  // Messenger client selection: "fca" (default, @dongdev/fca-unofficial)
  // or "go" (Go sidecar, mautrix/meta — one client for both regular groups
  // and E2EE DMs, no appstate renewal). Set with MESSENGER_CLIENT.
  messengerClient: getEnv("MESSENGER_CLIENT", "fca").toLowerCase(),
  goSidecarPath: getEnv("GO_SIDECAR_PATH", ""),
  goSidecarStateDir: getEnv("GO_SIDECAR_STATE_DIR", ""),
  // Socket watchdog (§34): while logged in, a Messenger socket that stays
  // down longer than this (ms) makes the client restart the sidecar —
  // otherwise a 401 disconnect with the process alive leaves the bot
  // deaf/mute until a manual restart. 0 disables the watchdog.
  socketDownRestartMs: getEnvNumber("SIDECAR_SOCKET_DOWN_RESTART_MS", 60_000),

  // LLM
  llm: {
    baseUrl: getEnv("LLM_BASE_URL", "https://api.openai.com/v1"),
    apiKey: getEnv("LLM_API_KEY", ""),
    // Runtime-switchable via `.model` (src/llm/model.ts); reads the stored
    // override if set, else the LLM_MODEL env default. A getter so every
    // LLM call site picks up a switch without code changes.
    get model() {
      return getCurrentModel();
    },
    visionEnabled: getEnvBoolean("LLM_VISION", true),
    maxToolCalls: getEnvNumber("MAX_TOOL_CALLS", 3),
    // Hard cap per LLM request so a stalled provider can't silence the bot.
    timeoutMs: getEnvNumber("LLM_TIMEOUT_MS", 90000),
  },

  // Storage backend (DB_BACKEND): "sqlite" (default — local bot.db),
  // "gateway" (Cloudflare D1 via the Worker, rollback only), or
  // "memory" (in-memory, tests/dev). SQLITE_PATH is the SQLite file
  // (relative to process cwd, i.e. the bot dir); ":memory:" is allowed.
  database: {
    backend: getEnv("DB_BACKEND", "sqlite"),
    sqlitePath: getEnv("SQLITE_PATH", "./bot.db"),
  },

  // Cloudflare D1 Gateway
  gateway: {
    url: getEnv("GATEWAY_URL", "").replace(/\/+$/, ""),
    token: getEnv("GATEWAY_TOKEN", ""),
  },

  // External APIs
  tavilyApiKey: getEnv("TAVILY_API_KEY", ""),
  braveApiKey: getEnv("BRAVE_API_KEY", ""),
  jinaReaderUrl: getEnv("JINA_READER_URL", "https://r.jina.ai/").replace(/\/+$/, "") + "/",
  // OmniRoute's own /v1/search endpoint (same host + key as the LLM).
  // Defaults to <LLM_BASE_URL>/search; override with OMNIROUTE_SEARCH_URL.
  omnirouteSearchUrl:
    getEnv("OMNIROUTE_SEARCH_URL", "") ||
    `${getEnv("LLM_BASE_URL", "https://api.openai.com/v1").replace(/\/+$/, "")}/search`,

  // Behavior limits
  historyLimit: getEnvNumber("HISTORY_LIMIT", 20),
  defaultSummaryN: getEnvNumber("DEFAULT_SUMMARY_N", 100),
  selfThreadId: getEnv("SELF_THREAD_ID", ""),
  rateLimitPerUserPerMin: getEnvNumber("RATE_LIMIT_PER_USER_PER_MIN", 5),
  maxReplyChars: getEnvNumber("MAX_REPLY_CHARS", 1800),
  memoryMaxChars: getEnvNumber("MEMORY_MAX_CHARS", 50000),
  styleMaxChars: getEnvNumber("STYLE_MAX_CHARS", 4000),
  autoLearnEvery: getEnvNumber("AUTO_LEARN_EVERY", 100),
  retentionDays: getEnvNumber("RETENTION_DAYS", 7),

  // Message reaction: the bot picks a diverse, context-aware emoji per
  // message (see reaction-picker). REACTION_EMOJI is only one fallback
  // option in the pool, not a fixed answer. Reactions are occasional, not
  // on every message — REACTION_RATE is the chance (0-1) a reply gets one.
  reactionEmoji: getEnv("REACTION_EMOJI", "❤️"),
  reactionEnabled: getEnvBoolean("REACTION_ENABLED", true),
  reactionRate: Math.min(1, Math.max(0, getEnvNumber("REACTION_RATE", 0.3))),

  // Typing-indicator "user" work mode: how long the indicator shows for a
  // reply, simulating a human typing. Duration = reply length / charsPerSec,
  // clamped to [minMs, maxMs]. Messenger hides the indicator ~5s after the
  // last typing event, so the client re-sends it every 3s while it is on.
  typing: {
    charsPerSec: getEnvNumber("TYPING_CHARS_PER_SEC", 10),
    minMs: getEnvNumber("TYPING_MIN_MS", 1000),
    maxMs: getEnvNumber("TYPING_MAX_MS", 30000),
  },

  // Outbound send pacing (anti-checkpoint, doc §6.3): minimum gap between
  // two outgoing messages + random jitter, so the bot never fires bursts
  // (several messages within a second reads as automation). Applies to
  // text, stickers and files, across all threads (one global queue).
  sendPacing: {
    minGapMs: getEnvNumber("SEND_MIN_GAP_MS", 1500),
    jitterMs: getEnvNumber("SEND_JITTER_MS", 1000),
  },

  // Human-like pause before an AI reply is sent (mimics reading the
  // message before typing). Random between min and max; 0/0 disables.
  replyDelay: {
    minMs: getEnvNumber("REPLY_DELAY_MIN_MS", 800),
    maxMs: getEnvNumber("REPLY_DELAY_MAX_MS", 2500),
  },

  // Logging
  logLevel: getEnv("LOG_LEVEL", "info"),
};
