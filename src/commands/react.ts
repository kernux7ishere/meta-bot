import { CommandHandler } from "./types.js";
import { config } from "../config.js";

/**
 * .react — toggle the bot's occasional emoji reactions. Owner only.
 *
 * Auto-reaction is diverse and contextual (the bot picks an emoji from the
 * message content) and occasional — only some replies get one, not every
 * message. There is no single fixed emoji and no manual reaction.
 *
 * - .react on  : enable auto-reaction
 * - .react off : disable auto-reaction
 */
export const reactCommand: CommandHandler = async ({ client, event, args }) => {
  const { threadID, messageID, senderID } = event;
  const currentBotUserId = client.getCurrentUserID();
  const ownerId = config.ownerId || currentBotUserId;

  if (senderID !== ownerId && senderID !== currentBotUserId) {
    return; // owner only
  }

  const sub = args[0]?.toLowerCase();
  const usage = "Cách dùng lệnh .react:\n• .react on : Bật tự động thả biểu cảm (thỉnh thoảng, theo ngữ cảnh)\n• .react off : Tắt tự động thả biểu cảm";

  if (sub === "on") {
    config.reactionEnabled = true;
    await client.sendMessage("Đã BẬT tự động thả biểu cảm (thỉnh thoảng, theo ngữ cảnh tin nhắn).", threadID, messageID);
    return;
  }

  if (sub === "off") {
    config.reactionEnabled = false;
    await client.sendMessage("Đã TẮT tự động thả biểu cảm.", threadID, messageID);
    return;
  }

  await client.sendMessage(usage, threadID, messageID);
};
