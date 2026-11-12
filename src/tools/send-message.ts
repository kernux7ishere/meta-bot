import { AgentTool } from "./types.js";
import { logger } from "../utils/logger.js";
import { namesFromHistory } from "./list-members.js";

export const sendMessageTool: AgentTool = {
  definition: {
    type: "function",
    function: {
      name: "send_message",
      description:
        "Send a text message to the chat immediately. Optionally @mention (ping) members by their user IDs — include each mentioned person's display name in the text (e.g. '@Phong ...') and pass their user IDs in mentions; the mention is then a real ping, not just text. Use this when the user asks to ping/tag a member, or to send a message that mentions someone. For an ordinary reply, just answer normally instead of using this tool.",
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "The message text to send. Include each mentioned person's display name (e.g. '@Phong') in the text.",
          },
          mentions: {
            type: "array",
            items: { type: "string" },
            description: "User IDs to @mention (ping). Get them from list_members first. Each mentioned person's display name must appear in text.",
          },
        },
        required: ["text"],
      },
    },
  },

  async execute(args: { text: string; mentions?: string[] }, context): Promise<string> {
    const client = context.client;
    if (!client) {
      return "Error: cannot send messages — no live Messenger client in this run.";
    }
    const text = (args.text || "").trim();
    if (!text) {
      return "Error: text is empty.";
    }
    const mentionIds = (args.mentions || []).map(String).filter((id) => id && id !== "0");
    if (mentionIds.length > 0) {
      // Resolve display names for the mentions (sidecar roster, then history).
      // Never mention the bot itself — the agent sometimes picks the bot's
      // own id by mistake (it used to appear as "Owner" in the member list).
      const botId = client.getCurrentUserID?.() || "";
      const targetIds = mentionIds.filter((id) => id !== botId);
      if (targetIds.length === 0) {
        return "Không ping được: không thể ping chính bot. Chọn một thành viên khác (dùng list_members để xem).";
      }
      let roster: Array<{ userID: string; name?: string }> = [];
      try {
        if (typeof (client as any).getThreadMembers === "function") {
          roster = await (client as any).getThreadMembers(context.threadId);
        }
      } catch {
        // fall back to history names only
      }
      const historyNames = await namesFromHistory(context.threadId, botId);
      const mentionRefs = targetIds.map((id) => {
        const fromRoster = roster.find((m) => m.userID === id);
        const name = fromRoster?.name || historyNames.get(id) || "";
        return { user_id: id, name };
      });
      // Drop mentions we have no display name for — without a name in the
      // text there is nothing to anchor the @mention to.
      const usable = mentionRefs.filter((m) => m.name);
      if (usable.length === 0) {
        return "Không ping được: không rõ tên hiển thị của các thành viên này. Dùng list_members để xem tên trước.";
      }
      // Deduplicate by display name: if two ids resolve to the same name
      // (e.g. the owner has two accounts both called "Dương Tuấn Phong"),
      // mentioning the name twice in one message makes Facebook NOT emit
      // the "mentioned you" notification (the 📣). Keep one per name,
      // preferring the sender when they are among the duplicates.
      const byName = new Map<string, { user_id: string; name: string }>();
      for (const m of usable) {
        const existing = byName.get(m.name);
        if (!existing) {
          byName.set(m.name, m);
        } else if (m.user_id === context.senderId && existing.user_id !== context.senderId) {
          byName.set(m.name, m);
        }
      }
      const deduped = [...byName.values()];
      // The text must contain "@Name" exactly once per kept mention; if the
      // agent wrote the name twice (once per duplicate id), collapse the
      // extra "@Name" so the text matches the deduped mentions.
      let finalText = text;
      for (const m of deduped) {
        const tag = `@${m.name}`;
        const first = finalText.indexOf(tag);
        if (first < 0) continue;
        const second = finalText.indexOf(tag, first + tag.length);
        if (second >= 0) {
          finalText = finalText.slice(0, second) + finalText.slice(second + tag.length).replace(/^\s+/, " ");
          finalText = finalText.replace(/\s{2,}/g, " ").trim();
        }
      }
      const missing = mentionRefs.filter((m) => !m.name).map((m) => m.user_id);
      try {
        await client.sendMessage(
          { body: finalText, mentions: deduped },
          context.threadId
        );
        logger.info({ threadId: context.threadId, mentions: deduped.map((m) => m.user_id) }, "Message sent with mentions");
        const note = missing.length > 0 ? ` (không ping được id ${missing.join(", ")} vì chưa rõ tên)` : "";
        return `Đã gửi tin nhắn và ping ${usable.map((m) => m.name).join(", ")}.${note}`;
      } catch (err: any) {
        logger.error({ err: err.message, threadId: context.threadId }, "Failed to send message with mentions");
        return `Gửi tin nhắn thất bại: ${err.message}`;
      }
    }
    try {
      await client.sendMessage(text, context.threadId);
      return "Đã gửi tin nhắn.";
    } catch (err: any) {
      logger.error({ err: err.message, threadId: context.threadId }, "Failed to send message");
      return `Gửi tin nhắn thất bại: ${err.message}`;
    }
  },
};
