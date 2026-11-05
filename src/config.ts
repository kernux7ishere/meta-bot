import dotenv from "dotenv";
import path from "node:path";

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

  // LLM
  llm: {
    baseUrl: getEnv("LLM_BASE_URL", "https://api.openai.com/v1"),
    apiKey: getEnv("LLM_API_KEY", ""),
    model: getEnv("LLM_MODEL", "gpt-4o"),
    visionEnabled: getEnvBoolean("LLM_VISION", true),
    maxToolCalls: getEnvNumber("MAX_TOOL_CALLS", 3),
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

  // Delay simulation
  minDelayMs: getEnvNumber("MIN_DELAY_MS", 1000),
  maxDelayMs: getEnvNumber("MAX_DELAY_MS", 2500),

  // Logging
  logLevel: getEnv("LOG_LEVEL", "info"),
};
