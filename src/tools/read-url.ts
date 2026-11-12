import { AgentTool } from "./types.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { truncate } from "../utils/text.js";
import { safeFetch } from "../utils/safe-fetch.js";
import { isSafeUrl } from "../llm/guards.js";

/** Per-fetch cap so a stalled page can't silence the bot. */
const READ_TIMEOUT_MS = 20000;

export const readUrlTool: AgentTool = {
  definition: {
    type: "function",
    function: {
      name: "read_url",
      description: "Read the main readable text content of a public web page URL using reader services.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The full HTTP/HTTPS URL of the web page to read",
          },
        },
        required: ["url"],
      },
    },
  },

  async execute(args: { url: string }): Promise<string> {
    const { url } = args;
    if (!url || !url.startsWith("http")) {
      return "Error: A valid HTTP or HTTPS URL is required.";
    }
    // Defense in depth: the agent-loop guard already checks URLs, but this
    // is the actual fetch point — refuse unsafe targets here too.
    const safe = isSafeUrl(url);
    if (!safe.safe) {
      return `Error: Refused unsafe URL (${safe.reason}).`;
    }

    logger.info({ url }, "Executing read_url");

    try {
      // 1. Fetch through Jina Reader (https://r.jina.ai/<url>)
      const jinaUrl = `${config.jinaReaderUrl}${url}`;
      const res = await safeFetch(
        jinaUrl,
        {
          headers: {
            Accept: "text/plain, text/markdown",
            "User-Agent": "Mozilla/5.0 (compatible; MessengerBot/1.0)",
          },
        },
        READ_TIMEOUT_MS
      );

      if (res.ok) {
        const text = await res.text();
        if (text && text.trim().length > 0) {
          // Wrap in untrusted data marker to remind the LLM
          return `[UNTRUSTED WEB CONTENT START - ${url}]\n${truncate(text.trim(), 4000)}\n[UNTRUSTED WEB CONTENT END]`;
        }
      }

      // 2. Fallback to direct fetch (SSRF-safe: host + redirects checked)
      const directRes = await safeFetch(
        url,
        {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          },
        },
        READ_TIMEOUT_MS
      );

      if (directRes.ok) {
        const html = await directRes.text();
        // Simple HTML stripping
        const stripped = html
          .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
          .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();

        return `[UNTRUSTED WEB CONTENT START - ${url}]\n${truncate(stripped, 3000)}\n[UNTRUSTED WEB CONTENT END]`;
      }

      return `Failed to fetch URL. HTTP status: ${res.status}`;
    } catch (err: any) {
      logger.error({ err: err.message, url }, "Error reading URL");
      return `Error reading URL: ${err.message}`;
    }
  },
};
