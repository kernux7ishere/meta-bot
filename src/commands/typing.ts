import { CommandHandler } from "./types.js";
import { config } from "../config.js";
import { db } from "../db/index.js";

type TypingMode = "user" | "bot";

const MODE_LABEL: Record<TypingMode, string> = {
  user: "user — giả lập người dùng: hiện typing indicator, thời gian theo độ dài câu trả lời",
  bot: "bot — trả lời nhanh, không hiện typing indicator",
};

function normalizeMode(arg: string | undefined): TypingMode | null {
  const v = (arg || "").toLowerCase();
  if (v === "user" || v === "on") return "user";
  if (v === "bot" || v === "off") return "bot";
  return null;
}

/**
 * .typing — typing-indicator work mode for this thread (owner-only).
 *   .typing            show the current mode
 *   .typing user       user mode: typing indicator on, duration ~ reply length
 *   .typing bot        bot mode: no indicator, reply as fast as possible
 *   .typing on / off   aliases for user / bot
 */
export const typingCommand: CommandHandler = async ({ client, event, args }) => {
  const { threadID, messageID, senderID } = event;
  const currentBotUserId = client.getCurrentUserID();
  const ownerId = config.ownerId || currentBotUserId;

  if (senderID !== ownerId && senderID !== currentBotUserId) {
    return; // owner only
  }

  const arg = args[0];

  // Bare .typing — show the current mode.
  if (!arg) {
    const mode = await db.getTypingMode(threadID);
    await client.sendMessage(`Chế độ typing hiện tại: ${MODE_LABEL[mode]}`, threadID, messageID);
    return;
  }

  const mode = normalizeMode(arg);
  if (!mode) {
    await client.sendMessage(
      "Cách dùng: .typing user | bot (hoặc .typing on | off)\n• user : Hiện typing indicator, thời gian theo độ dài câu trả lời\n• bot : Trả lời nhanh, không hiện typing indicator",
      threadID,
      messageID
    );
    return;
  }

  await db.setTypingMode(threadID, mode);
  await client.sendMessage(`Đã chuyển sang chế độ typing: ${MODE_LABEL[mode]}`, threadID, messageID);
};
