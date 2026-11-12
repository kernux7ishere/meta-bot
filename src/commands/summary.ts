import { CommandHandler } from "./types.js";
import { db, resolveSelfThreadId } from "../db/index.js";
import { getLlmClient } from "../llm/client.js";
import { config } from "../config.js";
import { chunkText } from "../utils/text.js";
import { logger } from "../utils/logger.js";

export const summaryCommand: CommandHandler = async ({ client, event, args }) => {
  const { threadID, messageID, senderID } = event;
  const currentBotUserId = client.getCurrentUserID();
  const ownerId = config.ownerId || currentBotUserId;

  if (senderID !== ownerId && senderID !== currentBotUserId) {
    return; // owner only
  }

  // Parse arguments: .summary [N] [here]
  let count = config.defaultSummaryN || 100;
  let destinationType: "self" | "here" = "self";

  const remainingArgs = [...args];

  // If first argument is a number
  if (remainingArgs.length > 0 && !isNaN(parseInt(remainingArgs[0], 10))) {
    const parsed = parseInt(remainingArgs[0], 10);
    if (parsed > 0) count = Math.min(parsed, 200);
    remainingArgs.shift();
  }

  if (remainingArgs.length > 0) {
    const sub = remainingArgs[0].toLowerCase();
    if (sub === "here") {
      destinationType = "here";
    }
  }

  // Resolve target thread ID
  let targetThreadId = "";
  if (destinationType === "here") {
    targetThreadId = threadID;
  } else {
    // Default to SELF_THREAD_ID (.env first, then the D1-persisted `.self set`).
    const selfId = await resolveSelfThreadId();
    if (!selfId) {
      await client.sendMessage(
        " Chưa cấu hình SELF_THREAD_ID! Vui lòng cấu hình trong file .env hoặc vào đoạn chat riêng của bạn và gõ '.self set'.",
        threadID,
        messageID
      );
      return;
    }
    targetThreadId = selfId;
  }

  // No typing indicator, no artificial delay: speed first.
  try {
    // Fetch messages from current thread
    // NOTE: Summaries are not filtered by access lists (per spec)
    const messages = await db.getRecentMessages(threadID, count);

    if (messages.length === 0) {
      await client.sendMessage("Chưa có lịch sử tin nhắn để tóm tắt cho nhóm này.", threadID, messageID);
      return;
    }

    const firstTime = new Date(messages[0].created_at).toLocaleString("vi-VN");
    const lastTime = new Date(messages[messages.length - 1].created_at).toLocaleString("vi-VN");

    const conversationText = messages
      .map((m) => `[${m.sender_name || `User_${m.sender_id.slice(-4)}`}]: ${m.body || ""}`)
      .join("\n");

    const prompt = `Bạn là trợ lý tổng hợp thông tin. Dưới đây là ${messages.length} tin nhắn gần nhất trong đoạn chat (từ ${firstTime} đến ${lastTime}).
Hãy tóm tắt ngắn gọn các chủ đề chính được thảo luận, các quyết định/thống nhất quan trọng, và các công việc/deadline cần chú ý (nếu có).
Định dạng tóm tắt bằng Tiếng Việt, dùng gạch đầu dòng rõ ràng, súc tích.

Nội dung trò chuyện:
${conversationText}`;

    const llm = getLlmClient();
    const completion = await llm.chat.completions.create({
      model: config.llm.model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 800,
    });

    const summary = completion.choices[0]?.message?.content?.trim() || "Không thể tạo tóm tắt.";

    // Prefix summary appropriately
    let fullSummaryText = "";
    if (destinationType === "here") {
      fullSummaryText = ` Tóm tắt đoạn chat (Nguồn: ${threadID} | Thời gian: ${firstTime} - ${lastTime}):\n\n${summary}`;
    } else {
      fullSummaryText = ` Tóm tắt ${messages.length} tin nhắn từ đoạn chat ${threadID} (${firstTime} - ${lastTime}):\n\n${summary}`;
    }

    const chunks = chunkText(fullSummaryText);
    for (let i = 0; i < chunks.length; i++) {
      await client.sendMessage(chunks[i], targetThreadId, destinationType === "here" && i === 0 ? messageID : undefined);
    }
  } catch (err: any) {
    logger.error({ err: err.message, threadID }, "Error in .summary command");
    await client.sendMessage(`Đã xảy ra lỗi khi tạo tóm tắt: ${err.message}`, threadID, messageID);
  }
};
