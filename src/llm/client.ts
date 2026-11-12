import OpenAI from "openai";
import { config } from "../config.js";

let clientInstance: OpenAI | null = null;

export function getLlmClient(): OpenAI {
  if (!clientInstance) {
    clientInstance = new OpenAI({
      baseURL: config.llm.baseUrl,
      apiKey: config.llm.apiKey || "dummy-key-for-local-ollama",
      // Hard cap per request: without this a stalled provider can hang the
      // agent loop (and silence the bot) for the SDK default of 10 minutes.
      timeout: config.llm.timeoutMs,
    });
  }
  return clientInstance;
}
