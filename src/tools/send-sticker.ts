import { AgentTool } from "./types.js";
import { logger } from "../utils/logger.js";
import { getSticker, listStickers } from "../sticker-pack.js";
import { searchStickerByMeaning } from "../sticker-vec.js";

/**
 * The sticker pack (src/sticker-pack.ts) is the single source of truth:
 * builtins (Facebook's Like stickers, verified) + stickers learned from
 * the owner. A sticker id is only added to the pack after it was seen
 * sent by the owner (or given explicitly) — an unknown id fails to send
 * and the tool reports the error to the chat.
 */
export const sendStickerTool: AgentTool = {
  definition: {
    type: "function",
    function: {
      name: "send_sticker",
      description:
        "Send a Facebook sticker to the chat. Give a sticker ID (a long number, e.g. '369239263222822'), a shortcut name from the pack ('like', 'like_small', 'like_large', or a learned sticker's name like 'learned_1'), an emotion ('agree'), or a feeling/situation in words ('buồn', 'cười xỉu', 'đồng ý') — when no name or emotion matches, the bot searches the stickers it learned by MEANING (each learned sticker was described with vision and embedded) and sends the closest one. The pack grows as the owner sends stickers — the bot learns which sticker they use for which feeling, and you can use those learned stickers here. Use this when the user asks for a sticker, or when a sticker fits the moment better than words (a quick agree, a laugh, a tease). Do NOT force a sticker reply every time the user sends one — use stickers only when they genuinely fit.",
      parameters: {
        type: "object",
        properties: {
          sticker_id: {
            type: "string",
            description: "Facebook sticker ID (a long number as a string).",
          },
          name: {
            type: "string",
            description: "Shortcut name or emotion from the sticker pack: 'like', 'like_small', 'like_large', a learned name like 'learned_1', or an emotion like 'agree'.",
          },
        },
      },
    },
  },

  async execute(args: { sticker_id?: string; name?: string }, context): Promise<string> {
    const client = context.client;
    if (!client) {
      return "Error: cannot send stickers — no live Messenger client in this run.";
    }

    let stickerId = (args.sticker_id || "").trim();
    let label = "";
    if (!stickerId && args.name) {
      const entry = getSticker(args.name);
      if (entry) {
        stickerId = entry.id;
        label = entry.label;
      } else {
        // No name/emotion match — semantic search: the query is a
        // feeling/situation, find the learned sticker whose vision
        // description means the closest thing.
        const hit = await searchStickerByMeaning(args.name, context.threadId);
        if (hit) {
          stickerId = hit.record.id;
          label = hit.record.description;
          logger.info(
            { query: args.name, similarity: hit.similarity, stickerId },
            "Sticker found by meaning"
          );
        } else {
          const names = listStickers()
            .map((e) => `${e.name} (${e.emotion})`)
            .join(", ");
          return `Không biết sticker "${args.name}". Các sticker có sẵn: ${names}. Hoặc đưa mình sticker ID cụ thể.`;
        }
      }
    }
    if (!stickerId || !/^\d+$/.test(stickerId)) {
      return "Error: provide a sticker ID (digits only) or a known pack name ('like', 'like_small', 'like_large').";
    }

    try {
      await client.sendMessage({ body: "", sticker: stickerId }, context.threadId);
      logger.info({ stickerId }, "Sticker sent to thread");
      return `Đã gửi sticker${label ? ` "${label}"` : ""} lên chat.`;
    } catch (err: any) {
      logger.error({ err: err.message, stickerId }, "Failed to send sticker");
      return `Gửi sticker thất bại: ${err.message}`;
    }
  },
};
