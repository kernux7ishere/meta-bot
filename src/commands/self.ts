import { CommandHandler } from "./types.js";
import { config } from "../config.js";
import { db, resolveSelfThreadId } from "../db/index.js";

export const selfCommand: CommandHandler = async ({ client, event, args }) => {
  const { threadID, messageID, senderID } = event;
  const currentBotUserId = client.getCurrentUserID();
  const ownerId = config.ownerId || currentBotUserId;

  if (senderID !== ownerId && senderID !== currentBotUserId) {
    return; // owner only
  }

  const subCommand = args[0]?.toLowerCase();

  // .self set — persist in D1 so it survives restarts, and update the
  // in-memory config so it takes effect immediately.
  if (subCommand === "set") {
    config.selfThreadId = threadID;
    await db.setSelfThreadId(threadID);
    await client.sendMessage(
      ` Đã đặt SELF_THREAD_ID thành công: ${threadID}. Các thông báo và tóm tắt cá nhân sẽ gửi về đây.`,
      threadID,
      messageID
    );
    return;
  }

  // .self show
  if (subCommand === "show") {
    const currentSelf = (await resolveSelfThreadId()) || "(Chưa cấu hình)";
    await client.sendMessage(` SELF_THREAD_ID hiện tại: ${currentSelf}`, threadID, messageID);
    return;
  }

  await client.sendMessage(
    "Cách dùng lệnh .self:\n• .self set : Chạy trong tin nhắn riêng (self-chat) để lưu làm SELF_THREAD_ID\n• .self show : Xem SELF_THREAD_ID hiện tại",
    threadID,
    messageID
  );
};
