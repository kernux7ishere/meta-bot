import { AgentTool } from "./types.js";
import { db } from "../db/index.js";
import { logger } from "../utils/logger.js";

/** Build a sender_id -> display name map from recent thread history, so
 *  members the sidecar only knows by id still get a readable name.
 *  `excludeUserId` (the bot's own id) is skipped: the router used to save
 *  the bot's own messages with sender_name "Owner", which made the bot
 *  look like the Owner in the member list and made the agent @mention
 *  itself instead of the real Owner. */
export async function namesFromHistory(threadId: string, excludeUserId?: string): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    const recent = await db.getRecentMessages(threadId, 200);
    for (const m of recent) {
      if (!m.sender_id || !m.sender_name || names.has(m.sender_id)) continue;
      if (excludeUserId && m.sender_id === excludeUserId) continue;
      names.set(m.sender_id, m.sender_name);
    }
  } catch (err: any) {
    logger.debug({ err: err.message, threadId }, "Could not load names from history");
  }
  return names;
}

export const listMembersTool: AgentTool = {
  definition: {
    type: "function",
    function: {
      name: "list_members",
      description:
        "List the members (participants) of this chat thread with their user IDs and names. Use this when the user asks who is in the group, or before pinging/@mentioning a member — you need their user ID to mention them.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },

  async execute(_args: Record<string, never>, context): Promise<string> {
    const client = context.client;
    let members: Array<{ userID: string; name?: string }> = [];
    if (client && typeof (client as any).getThreadMembers === "function") {
      try {
        members = await (client as any).getThreadMembers(context.threadId);
      } catch (err: any) {
        logger.warn({ err: err.message, threadId: context.threadId }, "getThreadMembers failed, falling back to history");
        members = [];
      }
    }
    // Fallback: the sidecar roster is empty until the LS table carries
    // participant events (the initial inbox load often does not). Rebuild
    // the member list from everyone who has spoken in this thread — that
    // covers the real members in practice. Exclude the bot itself so its
    // id is never presented as "Owner".
    const botId = client?.getCurrentUserID?.() || "";
    const historyNames = await namesFromHistory(context.threadId, botId);
    if (members.length === 0 && historyNames.size > 0) {
      members = [...historyNames.entries()].map(([userID, name]) => ({ userID, name }));
    }
    if (members.length === 0) {
      return "Không thấy thành viên nào trong đoạn chat này (danh sách thành viên trống và chưa có ai nhắn trong lịch sử).";
    }
    // Fill in names from message history where the sidecar has none.
    const lines = members.map((m) => {
      const name = m.name || historyNames.get(m.userID) || "(chưa rõ tên)";
      return `- ${name} (id: ${m.userID})`;
    });
    return `Thành viên trong đoạn chat (${members.length}):\n${lines.join("\n")}\nDùng user id này khi cần ping/@mention ai đó (qua tool send_message).`;
  },
};
