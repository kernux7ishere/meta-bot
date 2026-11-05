import { AgentTool, ToolExecutionContext } from "./types.js";
import { db } from "../db/index.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { consolidateMemory } from "../llm/consolidation.js";

export const rememberTool: AgentTool = {
  definition: {
    type: "function",
    function: {
      name: "remember",
      description:
        "Save or update important context, persistent facts, member preferences, or group rules into group memory.",
      parameters: {
        type: "object",
        properties: {
          note: {
            type: "string",
            description: "The fact, rule, or piece of information to remember (concise, factual bullet point)",
          },
        },
        required: ["note"],
      },
    },
  },

  async execute(args: { note: string }, context: ToolExecutionContext): Promise<string> {
    const { note } = args;
    const { threadId } = context;

    if (!note || !note.trim()) {
      return "Error: Note content cannot be empty.";
    }

    if (!threadId) {
      return "Error: Missing thread ID.";
    }

    logger.info({ threadId, note }, "Executing remember tool");

    try {
      const currentMemory = await db.getMemory(threadId);
      const newEntry = `- ${note.trim()}`;
      let updated = currentMemory ? `${currentMemory}\n${newEntry}` : newEntry;

      // Check if memory exceeded cap
      if (updated.length > config.memoryMaxChars) {
        logger.info({ threadId, length: updated.length }, "Memory exceeded cap, consolidating via LLM");
        updated = await consolidateMemory(updated);
      }

      await db.setMemory(threadId, updated);
      return `Successfully recorded into group memory: "${note.trim()}"`;
    } catch (err: any) {
      logger.error({ err: err.message, threadId }, "Failed to update memory");
      return `Failed to update memory: ${err.message}`;
    }
  },
};
