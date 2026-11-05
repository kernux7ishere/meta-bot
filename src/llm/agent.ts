import type {
  ChatCompletionMessageParam,
  ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions.js";
import { getLlmClient } from "./client.js";
import { allTools, toolsByName } from "../tools/index.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { buildSystemPrompt, buildChatHistory } from "../prompt/assembler.js";

export interface AgentRunOptions {
  threadId: string;
  senderId: string;
  senderName?: string;
  messageText: string;
  attachments?: Array<{ url: string; type: string }>;
  replyToText?: string;
}

export async function runAgent(options: AgentRunOptions): Promise<string> {
  const { threadId, senderId, senderName, messageText, attachments, replyToText } = options;

  const client = getLlmClient();
  const systemPrompt = await buildSystemPrompt(threadId);
  const history = await buildChatHistory(threadId, config.historyLimit);

  // Construct current user turn
  let userTurnText = "";
  if (senderName) {
    userTurnText += `[${senderName}]: `;
  } else {
    userTurnText += `[User_${senderId.slice(-4)}]: `;
  }

  if (replyToText) {
    userTurnText += `(in reply to: "${replyToText}")\n`;
  }

  userTurnText += messageText;

  if (attachments && attachments.length > 0) {
    userTurnText += `\n[Attachments available: ${attachments
      .map((a) => `${a.type.toUpperCase()}: ${a.url}`)
      .join(", ")}]`;
  }

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: userTurnText },
  ];

  let toolCallsCount = 0;
  const maxTools = config.llm.maxToolCalls;

  while (toolCallsCount < maxTools) {
    logger.debug({ toolCallsCount, model: config.llm.model }, "Calling LLM chat completion");

    const response = await client.chat.completions.create({
      model: config.llm.model,
      messages,
      tools: allTools.map((t) => t.definition),
      tool_choice: "auto",
      max_tokens: 1000,
    });

    const choice = response.choices[0];
    if (!choice || !choice.message) {
      return "Xin lỗi, hiện tại tôi không thể xử lý câu trả lời.";
    }

    const message = choice.message;

    // Check if tool calls were requested
    if (message.tool_calls && message.tool_calls.length > 0) {
      messages.push(message);

      for (const tc of message.tool_calls) {
        if (tc.type !== "function" || !("function" in tc)) continue;
        toolCallsCount++;
        const toolName = tc.function.name;
        const toolHandler = toolsByName.get(toolName);

        let resultStr = "";
        let parsedArgs: any = {};

        try {
          parsedArgs = JSON.parse(tc.function.arguments || "{}");
        } catch (e: any) {
          resultStr = `Invalid JSON arguments: ${e.message}`;
        }

        if (toolHandler && !resultStr) {
          logger.info({ tool: toolName, args: parsedArgs }, "Agent calling tool");
          try {
            resultStr = await toolHandler.execute(parsedArgs, { threadId, senderId });
          } catch (err: any) {
            logger.error({ tool: toolName, err: err.message }, "Tool execution threw error");
            resultStr = `Tool execution error: ${err.message}`;
          }
        } else if (!toolHandler) {
          resultStr = `Error: Unknown tool "${toolName}".`;
        }

        const toolReply: ChatCompletionToolMessageParam = {
          role: "tool",
          tool_call_id: tc.id,
          content: resultStr,
        };
        messages.push(toolReply);
      }

      // Continue agent loop to allow LLM to interpret tool result
      continue;
    }

    // No tool calls: return final content
    return message.content || "";
  }

  // If tool calls limit reached, do one final turn without tools
  logger.warn("Max tool calls reached. Requesting final answer without tools.");
  const finalResponse = await client.chat.completions.create({
    model: config.llm.model,
    messages,
    max_tokens: 1000,
  });

  return finalResponse.choices[0]?.message?.content || "";
}
