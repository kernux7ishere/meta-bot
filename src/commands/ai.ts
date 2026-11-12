import { CommandHandler } from "./types.js";
import { db } from "../db/index.js";
import { runAgent } from "../llm/agent.js";
import { chunkText } from "../utils/text.js";
import { formatAgentError } from "../utils/agent-error.js";
import { logger } from "../utils/logger.js";
import { reactToTrigger } from "../messenger/react.js";
import { typingDelayMs, sleep } from "../messenger/typing.js";
import { gatherAgentContext } from "../agent-context.js";

export const aiCommand: CommandHandler = async ({ client, event, args, rawText }) => {
  const { threadID, messageID, senderID } = event;
  const subCommand = args[0]?.toLowerCase();

  // 1. .ai on
  if (subCommand === "on") {
    await db.setThreadAiEnabled(threadID, true);
    await client.sendMessage("AI auto-reply đã được BẬT cho đoạn chat này.", threadID, messageID, senderID);
    return;
  }

  // 2. .ai off
  if (subCommand === "off") {
    await db.setThreadAiEnabled(threadID, false);
    await client.sendMessage("AI auto-reply đã được TẮT cho đoạn chat này.", threadID, messageID, senderID);
    return;
  }

  // 3. .ai <question> — typing-indicator work mode applies here too:
  // 'bot' = reply fast, no indicator; 'user' = show typing while thinking
  // and "typing" the reply out (duration ~ reply length).
  const question = args.join(" ").trim();
  if (!question) {
    await client.sendMessage(
      "Cách sử dụng lệnh .ai:\n- .ai on : Bật tự động trả lời trong nhóm\n- .ai off : Tắt tự động trả lời trong nhóm\n- .ai <câu hỏi> : Hỏi đáp trực tiếp với AI",
      threadID,
      messageID,
      senderID
    );
    return;
  }

  // Instant visual feedback while the LLM thinks (fire-and-forget).
  // The emoji is picked from the question content (diverse, contextual).
  reactToTrigger(client, messageID, threadID, question);

  const typingMode = await db.getTypingMode(threadID).catch(() => "bot" as const);
  let stopTyping: (() => void) | null = null;
  if (typingMode === "user") {
    stopTyping = await client.sendTypingIndicator(threadID);
  }
  const stop = () => {
    stopTyping?.();
    stopTyping = null;
  };

  try {
    // Same context as the auto-reply path (see agent-context.ts): the
    // current + replied-to attachments (reply chain), recent media,
    // bot-sent images, recent files. The command used to pass only the
    // current message's attachments, so `.ai` as a reply to a
    // photo/sticker/file saw nothing.
    const ctx = await gatherAgentContext(client, event);

    const answer = await runAgent({
      threadId: threadID,
      senderId: senderID,
      senderName: "Owner",
      messageText: question,
      attachments: ctx.attachments,
      recentMedia: ctx.recentMedia,
      sentImages: ctx.sentImages,
      recentAttachments: ctx.recentAttachments,
      givenFacts: ctx.givenFacts,
      replyToText: ctx.replyToText,
      client,
    });

    if (!answer || !answer.trim()) {
      stop();
      await client.sendMessage("Không nhận được phản hồi từ AI.", threadID, messageID, senderID);
      return;
    }

    if (typingMode === "user") {
      await sleep(typingDelayMs(answer.length));
    }
    stop();
    const chunks = chunkText(answer);
    for (let i = 0; i < chunks.length; i++) {
      await client.sendMessage(chunks[i], threadID, i === 0 ? messageID : undefined, i === 0 ? senderID : undefined);
    }
  } catch (err: any) {
    stop();
    logger.error({ err: err.message, threadID }, "Error in .ai command");
    await client.sendMessage(formatAgentError(err), threadID, messageID, senderID);
  }
};
