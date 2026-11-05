import { CommandHandler } from "./types.js";
import { db } from "../db/index.js";

export const memoryCommand: CommandHandler = async ({ client, event }) => {
  const { threadID, messageID } = event;
  const memory = await db.getMemory(threadID);

  if (!memory || !memory.trim()) {
    await client.sendMessage("Nhóm này hiện chưa có ghi nhớ ngữ cảnh nào.", threadID, messageID);
    return;
  }

  const responseText = ` Ghi nhớ ngữ cảnh của nhóm:\n\n${memory}`;
  await client.sendMessage(responseText, threadID, messageID);
};
