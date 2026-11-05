import { AgentTool } from "./types.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { truncate } from "../utils/text.js";

export const searchWebTool: AgentTool = {
  definition: {
    type: "function",
    function: {
      name: "search_web",
      description: "Search the web for real-time information, recent events, factual queries, and news.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query string",
          },
        },
        required: ["query"],
      },
    },
  },

  async execute(args: { query: string }): Promise<string> {
    const { query } = args;
    if (!query) return "Error: query is required";

    logger.info({ query }, "Executing search_web");

    // 1. Try Tavily API
    if (config.tavilyApiKey) {
      try {
        const res = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_key: config.tavilyApiKey,
            query,
            search_depth: "basic",
            max_results: 5,
          }),
        });

        if (res.ok) {
          const data = (await res.json()) as any;
          const results = data.results || [];
          if (results.length === 0) return "No results found.";

          const formatted = results
            .map((r: any, idx: number) => `[${idx + 1}] ${r.title}\nURL: ${r.url}\nSnippet: ${r.content}`)
            .join("\n\n");

          return truncate(formatted, 2500);
        }
      } catch (err: any) {
        logger.warn({ err: err.message }, "Tavily search failed, checking Brave");
      }
    }

    // 2. Try Brave Search API
    if (config.braveApiKey) {
      try {
        const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`;
        const res = await fetch(url, {
          headers: {
            Accept: "application/json",
            "X-Subscription-Token": config.braveApiKey,
          },
        });

        if (res.ok) {
          const data = (await res.json()) as any;
          const results = data.web?.results || [];
          if (results.length === 0) return "No results found.";

          const formatted = results
            .map((r: any, idx: number) => `[${idx + 1}] ${r.title}\nURL: ${r.url}\nSnippet: ${r.description}`)
            .join("\n\n");

          return truncate(formatted, 2500);
        }
      } catch (err: any) {
        logger.warn({ err: err.message }, "Brave search failed");
      }
    }

    // Fallback: DuckDuckGo Instant Answer / HTML scrape
    try {
      const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
      const res = await fetch(ddgUrl);
      if (res.ok) {
        const data = (await res.json()) as any;
        const text = data.AbstractText || data.Answer || "";
        if (text) {
          return `Instant Answer: ${text}\nSource: ${data.AbstractURL || "DuckDuckGo"}`;
        }
      }
    } catch {
      // ignore
    }

    return "Web search is currently unavailable. No valid API key (TAVILY_API_KEY or BRAVE_API_KEY) configured or service unreachable.";
  },
};
