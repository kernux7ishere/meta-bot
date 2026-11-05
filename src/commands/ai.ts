import { CommandHandler } from "./types.js";
import { db } from "../db/index.js";
import { runAgent } from "../llm/agent.js";
import { chunkText, sleep, getRandomDelay } from "../utils/text.js";
import { logger } from "../utils/logger.js";

export const aiCommand: CommandHandler = async ({ client, event, args, rawText }) => {
  const { threadID, messageID, senderID } = event;
  const subCommand = args[0]?.toLowerCase();

  // 1. .ai on
  if (subCommand === "on") {
    await db.setThreadAiEnabled(threadID, true);
    await client.sendMessage("AI auto-reply đã được BẬT cho đoạn chat này.", threadID, messageID);
    return;
  }

  // 2. .ai off
  if (subCommand === "off") {
    await db.setThreadAiEnabled(threadID, false);
    await client.sendMessage("AI auto-reply đã được TẮT cho đoạn chat này.", threadID, messageID);
    return;
  }

  // 3. .ai <question>
  const question = args.join(" ").trim();
  if (!question) {
    await client.sendMessage(
      "Cách sử dụng lệnh .ai:\n- .ai on : Bật tự động trả lời trong nhóm\n- .ai off : Tắt tự động trả lời trong nhóm\n- .ai <câu hỏi> : Hỏi đáp trực tiếp với AI",
      threadID,
      messageID
    );
    return;
  }

  const stopTyping = await client.sendTypingIndicator(threadID);

  try {
    const delay = getRandomDelay();
    await sleep(delay);

    const attachments = (event.attachments || []).map((att) => ({
      url: att.url || att.previewUrl || "",
      type: att.type || "file",
    }));

    const replyToText = event.messageReply?.body;

    const answer = await runAgent({
      threadId: threadID,
      senderId: senderID,
      senderName: "Owner",
      messageText: question,
      attachments,
      replyToText,
    });

    stopTyping();

    if (!answer || !answer.trim()) {
      await client.sendMessage("Không nhận được phản hồi từ AI.", threadID, messageID);
      return;
    }

    const chunks = chunkText(answer);
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) await sleep(600);
      await client.sendMessage(chunks[i], threadID, i === 0 ? messageID : undefined);
    }
  } catch (err: any) {
    stopTyping();
    logger.error({ err: err.message, threadID }, "Error in .ai command");
    await client.sendMessage(`Đã xảy ra lỗi khi xử lý câu hỏi: ${err.message}`, threadID, messageID);
  }
};
