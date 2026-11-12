import { CommandHandler } from "./types.js";
import { config } from "../config.js";
import { db } from "../db/index.js";

function normalizeArg(arg: string | undefined): boolean | null {
  const v = (arg || "").toLowerCase();
  if (v === "on" || v === "active" || v === "true") return true;
  if (v === "off" || v === "inactive" || v === "false") return false;
  return null;
}

/**
 * .presence — "Active now" status for the bot account (owner-only).
 * ON is AUTO: the account shows as active while there was activity
 * (a message in any thread, or a send) within the last 10 minutes,
 * and drifts to inactive after longer silence — like a real user who
 * put the phone down. OFF always looks offline.
 *   .presence         show whether the account shows as Đang hoạt động
 *   .presence on      auto active (FOREGROUND while recently active)
 *   .presence off     look offline (BACKGROUND app state)
 *
 * The choice persists in bot.db and is applied on startup.
 * Needs the Go sidecar — the fca client has no presence support.
 * (The 10-minute idle window is the sidecar default
 * SIDECAR_PRESENCE_IDLE; the texts here assume that default.)
 */
export const presenceCommand: CommandHandler = async ({ client, event, args }) => {
  const { threadID, messageID, senderID } = event;
  const currentBotUserId = client.getCurrentUserID();
  const ownerId = config.ownerId || currentBotUserId;

  if (senderID !== ownerId && senderID !== currentBotUserId) {
    return; // owner only
  }

  const arg = args[0];

  // Bare .presence — show the current state.
  if (!arg) {
    const enabled = await db.getPresenceEnabled();
    await client.sendMessage(
      enabled
        ? "Trạng thái hoạt động: BẬT (tự động) — hiện \"Đang hoạt động\" khi có tin nhắn gần đây, tự tắt sau 10 phút không có hoạt động."
        : "Trạng thái hoạt động: TẮT — tài khoản không hiện \"Đang hoạt động\".",
      threadID,
      messageID
    );
    return;
  }

  const enabled = normalizeArg(arg);
  if (enabled === null) {
    await client.sendMessage(
      "Cách dùng: .presence on | off\n• on : Tự động — hiện \"Đang hoạt động\" khi có hoạt động, tự tắt sau 10 phút im lặng\n• off : Không hiện trạng thái hoạt động",
      threadID,
      messageID
    );
    return;
  }

  await db.setPresenceEnabled(enabled);
  if (typeof client.setPresence === "function") {
    await client.setPresence(enabled);
  }
  await client.sendMessage(
    enabled
      ? "Đã bật trạng thái hoạt động (tự động) — hiện \"Đang hoạt động\" khi có hoạt động, tự tắt sau 10 phút im lặng."
      : "Đã tắt trạng thái hoạt động — tài khoản sẽ không hiện \"Đang hoạt động\" nữa.",
    threadID,
    messageID
  );
};
