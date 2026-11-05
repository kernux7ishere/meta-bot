import { CommandHandler } from "./types.js";
import { db } from "../db/index.js";
import { config } from "../config.js";

export const listCommand: CommandHandler = async ({ client, event, args }) => {
  const { threadID, messageID, senderID } = event;
  const currentBotUserId = client.getCurrentUserID();
  const ownerId = config.ownerId || currentBotUserId;

  if (senderID !== ownerId && senderID !== currentBotUserId) {
    return; // owner only
  }

  const subCommand = args[0]?.toLowerCase();

  // 1. .list mode off|whitelist|blacklist
  if (subCommand === "mode") {
    const mode = args[1]?.toLowerCase();
    if (!mode || !["off", "whitelist", "blacklist"].includes(mode)) {
      await client.sendMessage(
        "Chế độ không hợp lệ. Vui lòng chọn: .list mode off | whitelist | blacklist",
        threadID,
        messageID
      );
      return;
    }

    await db.setAccessMode(threadID, mode as "off" | "whitelist" | "blacklist");
    await client.sendMessage(` Đã chuyển chế độ truy cập của nhóm sang: ${mode.toUpperCase()}`, threadID, messageID);
    return;
  }

  // 2. .list global ban @user / .list global unban @user
  if (subCommand === "global") {
    const action = args[1]?.toLowerCase();
    let userIds: string[] = [];
    if (event.mentions && Object.keys(event.mentions).length > 0) {
      userIds = Object.keys(event.mentions);
    } else {
      userIds = args.slice(2).map((a) => a.replace(/^@/, "").trim()).filter(Boolean);
    }

    if (action !== "ban" && action !== "unban") {
      await client.sendMessage("Cách dùng: .list global ban @user hoặc .list global unban @user", threadID, messageID);
      return;
    }

    if (userIds.length === 0) {
      await client.sendMessage(`Vui lòng tag hoặc nhập ID người dùng: .list global ${action} @user`, threadID, messageID);
      return;
    }

    if (action === "ban") {
      for (const uid of userIds) {
        await db.addGlobalBlacklist(uid);
      }
      await client.sendMessage(` Đã thêm ${userIds.length} người dùng vào Global Blacklist: ${userIds.join(", ")}`, threadID, messageID);
      return;
    }

    if (action === "unban") {
      for (const uid of userIds) {
        await db.removeGlobalBlacklist(uid);
      }
      await client.sendMessage(` Đã gỡ ${userIds.length} người dùng khỏi Global Blacklist: ${userIds.join(", ")}`, threadID, messageID);
      return;
    }
  }

  // 3. .list show
  if (subCommand === "show") {
    const data = await db.getAccessList(threadID);
    const globalList = await db.getGlobalBlacklist();
    const whiteStr = data.whitelist.length > 0 ? data.whitelist.join(", ") : "(trống)";
    const blackStr = data.blacklist.length > 0 ? data.blacklist.join(", ") : "(trống)";
    const globalStr = globalList.length > 0 ? globalList.join(", ") : "(trống)";

    const reply = ` Cấu hình kiểm soát truy cập (Access Control):
• Chế độ nhóm hiện tại: ${data.access_mode.toUpperCase()}
• Whitelist của nhóm: ${whiteStr}
• Blacklist của nhóm: ${blackStr}
• Global Blacklist: ${globalStr}`;

    await client.sendMessage(reply, threadID, messageID);
    return;
  }

  // 4. .list add @user / user_id
  if (subCommand === "add") {
    const data = await db.getAccessList(threadID);
    if (data.access_mode === "off") {
      await client.sendMessage(
        "Chế độ hiện tại của nhóm là OFF. Vui lòng bật whitelist hoặc blacklist trước (.list mode whitelist/blacklist).",
        threadID,
        messageID
      );
      return;
    }

    let userIds: string[] = [];
    if (event.mentions && Object.keys(event.mentions).length > 0) {
      userIds = Object.keys(event.mentions);
    } else {
      userIds = args.slice(1).map((a) => a.replace(/^@/, "").trim()).filter(Boolean);
    }

    if (userIds.length === 0) {
      await client.sendMessage("Vui lòng tag hoặc nhập ID người dùng cần thêm: .list add @user", threadID, messageID);
      return;
    }

    const targetList = data.access_mode === "whitelist" ? "white" : "black";
    for (const uid of userIds) {
      await db.addToAccessList(threadID, uid, targetList);
    }

    await client.sendMessage(
      ` Đã thêm ${userIds.length} người dùng vào ${data.access_mode} của nhóm: ${userIds.join(", ")}`,
      threadID,
      messageID
    );
    return;
  }

  // 5. .list remove @user / user_id
  if (subCommand === "remove") {
    let userIds: string[] = [];
    if (event.mentions && Object.keys(event.mentions).length > 0) {
      userIds = Object.keys(event.mentions);
    } else {
      userIds = args.slice(1).map((a) => a.replace(/^@/, "").trim()).filter(Boolean);
    }

    if (userIds.length === 0) {
      await client.sendMessage("Vui lòng tag hoặc nhập ID người dùng cần xóa: .list remove @user", threadID, messageID);
      return;
    }

    for (const uid of userIds) {
      await db.removeFromAccessList(threadID, uid);
    }

    await client.sendMessage(
      ` Đã xóa ${userIds.length} người dùng khỏi danh sách của nhóm: ${userIds.join(", ")}`,
      threadID,
      messageID
    );
    return;
  }

  await client.sendMessage(
    "Cách dùng lệnh .list:\n• .list mode off|whitelist|blacklist\n• .list add @user\n• .list remove @user\n• .list show\n• .list global ban @user\n• .list global unban @user",
    threadID,
    messageID
  );
};
