import OpenAI from "openai";
import { config } from "../config.js";

let clientInstance: OpenAI | null = null;

export function getLlmClient(): OpenAI {
  if (!clientInstance) {
    clientInstance = new OpenAI({
      baseURL: config.llm.baseUrl,
      apiKey: config.llm.apiKey || "dummy-key-for-local-ollama",
    });
  }
  return clientInstance;
}
