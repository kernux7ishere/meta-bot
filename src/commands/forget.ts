import { CommandHandler } from "./types.js";
import { db } from "../db/index.js";

export const forgetCommand: CommandHandler = async ({ client, event, args }) => {
  const { threadID, messageID } = event;
  const isConfirmed = args[0]?.toLowerCase() === "confirm";

  if (!isConfirmed) {
    await client.sendMessage(
      " Cảnh báo: Lệnh này sẽ xóa toàn bộ ghi nhớ (memory) của nhóm chat này.\nĐể xác nhận, vui lòng gõ: .forget confirm",
      threadID,
      messageID
    );
    return;
  }

  await db.setMemory(threadID, "");
  await client.sendMessage(" Đã xóa sạch toàn bộ ghi nhớ của nhóm chat này.", threadID, messageID);
};
