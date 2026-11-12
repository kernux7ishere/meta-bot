import { logger } from "../utils/logger.js";
import type { MessengerClient } from "./types.js";

export interface RecentMedia {
  url: string;
  /** Attachment type as Messenger reports it: "photo", "sticker", "animated_image", "video", "file", ... */
  type: string;
  senderId?: string;
  messageId?: string;
}

/** Attachment types the vision tool can actually read (they are images). */
const READABLE_MEDIA = new Set(["photo", "sticker", "animated_image", "image"]);

/**
 * Fetch the thread's recent messages and pull out image/sticker attachments.
 * Used when the user refers to something sent earlier ("mô tả sticker đó",
 * "ảnh vừa gửi") — the sticker/image lives on a previous message, not on
 * the current one, so the agent would otherwise have no URL to read.
 * Best-effort: returns [] on any failure (the agent just answers without
 * the media context). Capped so one slow history fetch can't stall a reply.
 */
export async function getRecentMediaAttachments(
  client: MessengerClient,
  threadId: string,
  currentMessageId: string,
  limit = 10
): Promise<RecentMedia[]> {
  if (typeof client.getThreadHistory !== "function") return [];
  let history: any[];
  try {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("getThreadHistory timed out")), 10000)
    );
    history = await Promise.race([
      client.getThreadHistory(threadId, limit),
      timeout,
    ]);
  } catch (err: any) {
    logger.warn({ err: err.message, threadId }, "Could not fetch recent thread history for media lookup");
    return [];
  }
  if (!Array.isArray(history)) return [];

  const seen = new Set<string>();
  const media: RecentMedia[] = [];
  for (const msg of history) {
    if (!msg || msg.messageID === currentMessageId) continue;
    const atts = Array.isArray(msg.attachments) ? msg.attachments : [];
    for (const att of atts) {
      const type = String(att?.type || "").toLowerCase();
      if (!READABLE_MEDIA.has(type)) continue;
      const url = att?.url || att?.previewUrl || "";
      if (!url || seen.has(url)) continue;
      seen.add(url);
      media.push({
        url,
        type,
        senderId: msg.senderID,
        messageId: msg.messageID,
      });
      // Keep the context small — the most recent few are what matters.
      if (media.length >= 5) return media;
    }
  }
  return media;
}
