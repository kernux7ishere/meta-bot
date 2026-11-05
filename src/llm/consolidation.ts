import { getLlmClient } from "./client.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

/**
 * Consolidates memory notes using LLM when it exceeds the character limit.
 * Merges duplicates, drops stale items, and keeps it compact under the limit.
 */
export async function consolidateMemory(rawNotes: string): Promise<string> {
  try {
    const client = getLlmClient();
    const prompt = `You are a memory consolidation engine. Below is a raw list of notes/facts for a chat group.
Your task is to rewrite, condense, and merge these notes into a clean, concise markdown list.
Rules:
- Eliminate duplicates and outdated/contradictory info.
- Keep member facts, preferences, and important group rules.
- Output MUST be compact and strictly under ${config.memoryMaxChars - 200} characters.
- Use bullet points.
- Return ONLY the consolidated markdown notes without any introductory or concluding comments.

Raw Notes:
${rawNotes}`;

    const completion = await client.chat.completions.create({
      model: config.llm.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: 600,
    });

    const consolidated = completion.choices[0]?.message?.content?.trim();
    if (consolidated && consolidated.length > 0) {
      return consolidated;
    }
  } catch (err: any) {
    logger.error({ err: err.message }, "Memory consolidation LLM call failed");
  }

  // Fallback: simple truncation from the beginning or keep newest lines
  const lines = rawNotes.split("\n").filter((l) => l.trim().length > 0);
  let result = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    const candidate = `${lines[i]}\n${result}`;
    if (candidate.length > config.memoryMaxChars) break;
    result = candidate;
  }
  return result.trim();
}
