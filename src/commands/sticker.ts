import { CommandHandler } from "./types.js";
import { config } from "../config.js";
import { listStickers, tagSticker } from "../sticker-pack.js";
import { getStickerDescription } from "../sticker-vec.js";

/**
 * .sticker — the bot's sticker pack (owner-only).
 *   .sticker                  list known stickers (builtins + learned)
 *   .sticker tag <id> <name> [emotion]
 *                             rename / re-tag a LEARNED sticker so the
 *                             agent can call it by name or emotion, e.g.
 *                             .sticker tag 123456789 vui happy
 *                             (builtins cannot be renamed)
 *
 * Learning is automatic: every sticker the owner sends (in any thread,
 * including the sticker-learning group) is recorded in the pack with
 * the surrounding text as context. This command is only for viewing
 * the pack and giving learned stickers a useful name/emotion.
 */
export const stickerCommand: CommandHandler = async ({ client, event, args }) => {
  const { threadID, messageID, senderID } = event;
  const currentBotUserId = client.getCurrentUserID();
  const ownerId = config.ownerId || currentBotUserId;

  if (senderID !== ownerId && senderID !== currentBotUserId) {
    return; // owner only
  }

  const sub = (args[0] || "").toLowerCase();

  // .sticker tag <id> <name> [emotion]
  if (sub === "tag") {
    const id = (args[1] || "").trim();
    const name = (args[2] || "").trim();
    const emotion = (args[3] || "").trim();
    if (!id || !/^\d+$/.test(id) || !name) {
      await client.sendMessage(
        "Cách dùng: .sticker tag <sticker_id> <tên> [cảm xúc]\nVí dụ: .sticker tag 123456789 vui happy",
        threadID,
        messageID
      );
      return;
    }
    const entry = tagSticker(id, { name, emotion: emotion || undefined });
    if (!entry) {
      await client.sendMessage(
        `Không gắn tên được cho sticker ${id} — có thể nó chưa được học (gửi sticker đó cho bot trước) hoặc là sticker mặc định.`,
        threadID,
        messageID
      );
      return;
    }
    await client.sendMessage(
      `Đã gắn tên: "${entry.name}" (${entry.emotion}) — ${entry.label}`,
      threadID,
      messageID
    );
    return;
  }

  // Bare .sticker — list the pack. Stickers described with vision show
  // their description (~ ...) — those are the ones send_sticker can find
  // by meaning, not just by name/emotion.
  const entries = listStickers();
  const lines = entries.map((e) => {
    const desc = getStickerDescription(e.id);
    return `• ${e.name} — ${e.label} [${e.emotion}]${e.context ? ` — "${e.context}"` : ""}${desc ? `\n  ~ ${desc}` : ""}`;
  });
  const text =
    `Sticker pack (${entries.length}):\n${lines.join("\n")}` +
    `\n\nBot tự học sticker bạn gửi (kể cả trong group học sticker). Đặt tên/cảm xúc: .sticker tag <id> <tên> [cảm xúc]`;
  await client.sendMessage(text, threadID, messageID);
};
