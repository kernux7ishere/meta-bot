import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { MessengerClient } from "./types.js";
import { pickReaction } from "./reaction-picker.js";

/**
 * React to a triggering message with a diverse, context-aware emoji
 * (fire-and-forget). Reactions are occasional, not on every message —
 * only `reactionRate` of replies get one, so it stays spontaneous.
 * Never throws — a failed reaction must not break the text reply.
 */
export function reactToTrigger(
  client: MessengerClient,
  messageID: string,
  threadID: string,
  messageText = ""
): void {
  if (!config.reactionEnabled || !messageID) return;
  if (Math.random() > config.reactionRate) return;
  const emoji = pickReaction(messageText, config.reactionEmoji);
  client.setMessageReaction(emoji, messageID, threadID).catch((err) => {
    logger.warn({ err: err?.message, messageID }, "Reaction failed (ignored)");
  });
}
