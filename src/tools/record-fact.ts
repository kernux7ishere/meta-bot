import { AgentTool, ToolExecutionContext } from "./types.js";
import { recordGivenFact } from "../given-facts.js";
import { logger } from "../utils/logger.js";

/**
 * record_fact — the anti-repeat half of fact giving. The agent MUST call
 * this with every fact/trivia it gives the user (in the same turn, right
 * after deciding the fact), so the next turn's context lists it and the
 * bot never gives the same fact twice — not even reworded. Without this
 * call the fact is lost: tool results are not saved to history.
 */
export const recordFactTool: AgentTool = {
  definition: {
    type: "function",
    function: {
      name: "record_fact",
      description:
        "Record a fact or trivia you just gave (or are about to give) the user, so you never repeat it in this thread — not even reworded. Call this in the same turn, immediately after choosing the fact. Use the fact's full text as you gave it.",
      parameters: {
        type: "object",
        properties: {
          fact: {
            type: "string",
            description: "The full text of the fact/trivia as given to the user",
          },
        },
        required: ["fact"],
      },
    },
  },

  async execute(args: { fact: string }, context: ToolExecutionContext): Promise<string> {
    const { fact } = args;
    const { threadId } = context;

    if (!fact || !fact.trim()) {
      return "Error: Fact content cannot be empty.";
    }
    if (!threadId) {
      return "Error: Missing thread ID.";
    }

    const isNew = recordGivenFact(threadId, fact.trim());
    if (!isNew) {
      logger.warn({ threadId }, "record_fact: fact already given in this thread");
      return "STOP — this fact (or an equivalent) was already given in this thread. Do NOT give it to the user. Pick a DIFFERENT fact and record that one instead.";
    }
    return "Recorded: this fact will not be repeated in this thread.";
  },
};
