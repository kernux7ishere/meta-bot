import type { ChatCompletionTool } from "openai/resources/chat/completions.js";
import type { MessengerClient } from "../messenger/types.js";

export interface ToolExecutionContext {
  threadId: string;
  senderId: string;
  /** Messenger client — present when the tool runs inside a live chat, so
   *  a tool can send an attachment/sticker back to the thread. Absent in
   *  unit tests and offline runs. */
  client?: MessengerClient;
}

export interface AgentTool {
  definition: ChatCompletionTool;
  execute: (args: any, context: ToolExecutionContext) => Promise<string>;
}

