import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions.js";

export interface ToolExecutionContext {
  threadId: string;
  senderId: string;
}

export interface AgentTool {
  definition: ChatCompletionFunctionTool;
  execute: (args: any, context: ToolExecutionContext) => Promise<string>;
}

