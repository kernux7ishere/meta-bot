import type {
  ChatCompletionMessageParam,
  ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions.js";
import { getLlmClient } from "./client.js";
import { allTools, toolsByName } from "../tools/index.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { buildSystemPrompt, buildChatHistory } from "../prompt/assembler.js";
import type { MessengerClient } from "../messenger/types.js";
import type { RecentMedia } from "../messenger/recent-media.js";
import { checkToolCall } from "./guards.js";

export interface AgentRunOptions {
  threadId: string;
  senderId: string;
  senderName?: string;
  messageText: string;
  attachments?: Array<{ url: string; type: string }>;
  /** Image/sticker attachments from recent messages in this thread (not the
   *  current one). Lets the agent describe media the user refers to from an
   *  earlier message ("mô tả sticker đó"). */
  recentMedia?: RecentMedia[];
  /** Images the bot itself sent in this thread recently (URL + what they
   *  were). Lets the agent answer follow-ups about its own sends
   *  ("mô tả nó", "ảnh vừa gửi là gì") — without this the next turn has
   *  no trace of the image, because tool results are not saved to history
   *  and the Go client can't return thread history. */
  sentImages?: Array<{ url: string; query?: string; title?: string }>;
  /** Files/images OTHER people sent in this thread recently (URL +
   *  filename + type). Lets the agent answer "đọc file này" when the
   *  file was sent in an earlier message — without this the next turn
   *  has no trace of it at all. */
  recentAttachments?: Array<{ url: string; name?: string; type: string; mime?: string; size?: number }>;
  /** Facts/trivia the bot already gave in this thread (newest first).
   *  The agent must never give one of these again — not even reworded —
   *  and must record every new fact with the record_fact tool. */
  givenFacts?: string[];
  replyToText?: string;
  /** Live Messenger client, so tools can send images/files/stickers back
   *  to the thread. Optional — the agent still works without it. */
  client?: MessengerClient;
}

export async function runAgent(options: AgentRunOptions): Promise<string> {
  const { threadId, senderId, senderName, messageText, attachments, recentMedia, sentImages, recentAttachments, givenFacts, replyToText } = options;
  const messengerClient = options.client;

  const client = getLlmClient();
  const systemPrompt = await buildSystemPrompt(threadId);
  const history = await buildChatHistory(
    threadId,
    config.historyLimit,
    messengerClient?.getCurrentUserID?.()
  );

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

  // Media from earlier messages in this thread, so the user can ask about
  // something already sent ("mô tả sticker đó", "ảnh vừa gửi là gì").
  // A sticker IS a readable image — call read_image with its URL.
  if (recentMedia && recentMedia.length > 0) {
    userTurnText += `\n[Recent images/stickers in this thread (most recent first): ${recentMedia
      .map((m) => `${m.type.toUpperCase()}: ${m.url}`)
      .join(", ")}]`;
  }

  // Images the bot itself sent in this thread recently. This is the
  // context the agent otherwise loses completely: the send_image tool
  // result is not in the next turn's history, so when the user says
  // "mô tả nó" / "ảnh vừa gửi là gì" / "đây" with no image attached,
  // they mean the most recent image here. Call read_image with its URL
  // to look at it before answering. Never ask the user to resend the
  // link or the image — you already have the URL.
  if (sentImages && sentImages.length > 0) {
    userTurnText += `\n[Images YOU (the bot) sent in this thread (most recent first): ${sentImages
      .map((s) => `${s.title ? `"${s.title.replace(/^File:/, "")}"` : "image"}${s.query ? ` (searched: ${s.query})` : ""}: ${s.url}`)
      .join(", ")}]`;
  }

  // Files/images OTHER people sent in this thread recently. Same
  // amnesia, other direction: when the user says "đọc file này",
  // "tóm tắt file vừa gửi", "nó", "đây" with no file attached to the
  // current message, they mean the most recent matching file here.
  // Call read_file (documents) or read_image (images) with its URL.
  // Never ask the user to resend the link or the file — you already
  // have the URL. (These are Facebook CDN links: they expire after a
  // while, so if read_file fails, say the link expired instead of
  // asking for a resend of something sent long ago.)
  if (recentAttachments && recentAttachments.length > 0) {
    const fmtSize = (n?: number) =>
      n === undefined ? "" : n >= 1024 * 1024 ? ` (${(n / (1024 * 1024)).toFixed(1)} MiB)` : n >= 1024 ? ` (${Math.round(n / 1024)} KiB)` : ` (${n} B)`;
    userTurnText += `\n[Recent files/images others sent in this thread (most recent first): ${recentAttachments
      .map((a) => `${a.type.toUpperCase()}${a.name ? ` "${a.name}"` : ""}${fmtSize(a.size)}: ${a.url}`)
      .join(", ")}]`;
  }

  // Facts the bot already gave in this thread. This is the anti-repeat
  // list: before giving a fact/trivia, check it against these and pick
  // a DIFFERENT one — a rewording of a listed fact still counts as a
  // repeat (the honey fact was given twice, 2026-11-12, because the
  // agent only had raw history and never checked it). Then record the
  // new fact with the record_fact tool in the same turn, or the next
  // turn will have nothing to check against.
  if (givenFacts && givenFacts.length > 0) {
    userTurnText += `\n[Facts YOU already gave in this thread (most recent first) — NEVER give any of these again, not even reworded: ${givenFacts
      .map((f) => `"${f.replace(/\n/g, " ").slice(0, 200)}"`)
      .join(" | ")}]`;
  }

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: userTurnText },
  ];

  let toolCallsCount = 0;
  const maxTools = config.llm.maxToolCalls;

  // Taint tracking (Hermes airlock-style): once this turn reads untrusted
  // content (web / file / image / search results), outbound write tools
  // (remember, sends) are held to stricter rules by the guard. The flag
  // lives in code, not in the prompt, so an injection cannot clear it.
  let tainted = false;
  const READ_TOOLS = new Set(["search_web", "read_url", "read_image", "read_file", "reverse_image_search"]);

  while (toolCallsCount < maxTools) {
    logger.debug({ toolCallsCount, model: config.llm.model }, "Calling LLM chat completion");

    let response;
    try {
      response = await client.chat.completions.create({
        model: config.llm.model,
        messages,
        tools: allTools.map((t) => t.definition),
        tool_choice: "auto",
        max_tokens: 1000,
      });
    } catch (err: any) {
      // The vyce/deepseek-v4.1 provider flakily rejects some requests that
      // carry tool results (HTTP 400 "Invalid request") even though the
      // same shape succeeds on retry. Fall back once to a plain text-only
      // call (no tools) so the turn still produces an answer from the tool
      // results already gathered, instead of failing the whole reply.
      if (err?.status === 400) {
        logger.warn({ err: err.message }, "LLM call rejected (400); retrying without tools");
        try {
          response = await client.chat.completions.create({
            model: config.llm.model,
            messages,
            max_tokens: 1000,
          });
        } catch (retryErr: any) {
          retryErr.step = "LLM";
          throw retryErr;
        }
      } else {
        // Annotate with the failing step so the chat error message says
        // exactly what broke (LLM vs a specific tool), not just the raw text.
        err.step = "LLM";
        throw err;
      }
    }

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
          // CODE-LEVEL GUARD (Hermes-style): inspect the tool call BEFORE
          // it runs. A blocked call is reported back to the LLM as a tool
          // result so it can explain — it is never executed. If the guard
          // itself throws, fail closed (block) — a broken guard must not
          // become a bypass.
          let verdict: { allowed: boolean; reason?: string };
          try {
            verdict = checkToolCall(toolName, parsedArgs, { tainted, threadId });
          } catch (guardErr: any) {
            logger.error({ err: guardErr?.message, tool: toolName }, "Guard threw; failing closed");
            verdict = { allowed: false, reason: "blocked: safety guard error" };
          }
          if (!verdict.allowed) {
            logger.warn({ tool: toolName, reason: verdict.reason, threadId }, "Tool call blocked by safety guard");
            resultStr = `Tool call blocked by safety guard: ${verdict.reason}. Do not retry it with the same arguments; explain to the user instead if they asked for it.`;
          } else {
            try {
              resultStr = await toolHandler.execute(parsedArgs, { threadId, senderId, client: messengerClient });
              // Reading untrusted content taints this turn (airlock-style).
              if (READ_TOOLS.has(toolName)) tainted = true;
            } catch (err: any) {
              logger.error({ tool: toolName, err: err.message }, "Tool execution threw error");
              resultStr = `Tool "${toolName}" error: ${err.message}`;
            }
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
  let finalResponse;
  try {
    finalResponse = await client.chat.completions.create({
      model: config.llm.model,
      messages,
      max_tokens: 1000,
    });
  } catch (err: any) {
    err.step = "LLM (final answer)";
    throw err;
  }

  return finalResponse.choices[0]?.message?.content || "";
}
