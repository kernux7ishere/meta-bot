// Shared agent context — what the agent needs to see before runAgent.
//
// The auto-reply path (sendAiReply, @mention / reply-to-bot) and the
// `.ai <question>` command used to build this context DIFFERENTLY: the
// command only passed the current message's attachments, so `.ai` as a
// reply to a photo/sticker/file saw nothing — "hỏi cái gì cơ, gửi ảnh
// hay gửi link đi" (proven 2026-11-11). Both paths now call
// gatherAgentContext, so a question asked either way resolves the same
// media.
//
// What it gathers:
// - the current message's attachments + the replied-to message's
//   attachments, walking up the reply chain (resolveReplyChainAttachments)
//   — the sidecar only sends the replied-to id, never its attachments;
// - when nothing readable is attached, the thread's recent media
//   (history lookup, [] under Go), images the BOT sent (sent-images
//   table — tool results aren't saved in history), and recent files
//   others sent (recent_attachments table).

import type { IncomingEvent, MessengerClient } from "./messenger/types.js";
import { getRecentMediaAttachments, RecentMedia } from "./messenger/recent-media.js";
import { getRecentSentImages } from "./sent-images.js";
import { getRecentGivenFacts } from "./given-facts.js";
import { getRecentAttachments, resolveReplyChainAttachments, RecentAttachment } from "./recent-attachments.js";

export interface AgentContext {
  attachments: Array<{ url: string; type: string }>;
  recentMedia: RecentMedia[];
  sentImages: Array<{ url: string; query?: string; title?: string }>;
  recentAttachments: RecentAttachment[];
  /** Facts/trivia the bot already gave in this thread (newest first) —
   *  the anti-repeat list: the agent must not give any of these again,
   *  not even reworded. */
  givenFacts: string[];
  replyToText?: string;
}

export async function gatherAgentContext(
  client: MessengerClient,
  event: IncomingEvent
): Promise<AgentContext> {
  const { threadID, messageID } = event;
  const attachments = (event.attachments || []).map((att) => ({
    url: att.url || att.previewUrl || "",
    type: att.type || "file",
  }));
  // Also include the message being replied to — a user often replies to a
  // photo/sticker message and asks about it ("mô tả cái này").
  const replyAttachments = (event.messageReply?.attachments || []).map((att) => ({
    url: att.url || att.previewUrl || "",
    type: att.type || "file",
  }));
  // The sidecar only sends the replied-to message's id, never its
  // attachments — resolve them from the recorded attachments (the
  // message itself was recorded when it arrived), walking the whole
  // reply chain: the user often replies to a reply, so the
  // directly-replied message may be a plain text message with nothing
  // attached. Without the walk, replying to a reply with "mô tả cái
  // này" sees nothing.
  if (replyAttachments.length === 0 && event.messageReply?.messageID) {
    const resolved = resolveReplyChainAttachments(threadID, event.messageReply.messageID);
    for (const a of resolved) {
      if (a.url) replyAttachments.push({ url: a.url, type: a.type || "file" });
    }
  }
  const allAttachments = [...attachments, ...replyAttachments].filter((a) => a.url);
  // If this message carries no readable image/sticker itself, look back at
  // the thread's recent media: the user may be asking about a sticker or
  // photo sent a message or two ago ("mô tả sticker đó" as a reply to the
  // bot's own reply). Without this the agent has no URL to read.
  // Same for images the BOT sent: the next turn's history has no trace of
  // them (tool results aren't saved), and the Go client can't return thread
  // history — so "mô tả nó" after a send_image would otherwise make the
  // bot ask the user to resend the link. The sent-images file is the
  // only record; inject the most recent few.
  let recentMedia: RecentMedia[] = [];
  let sentImages: Array<{ url: string; query?: string; title?: string }> = [];
  let recentAttachments: RecentAttachment[] = [];
  const hasReadable = allAttachments.some((a) =>
    ["photo", "sticker", "animated_image", "image"].includes(a.type.toLowerCase())
  );
  if (!hasReadable) {
    recentMedia = await getRecentMediaAttachments(client, threadID, messageID);
    sentImages = getRecentSentImages(threadID, 3);
    // Files others sent a message or two ago ("đọc file này"): the
    // history lookup above only covers images and returns [] under Go,
    // so the recorded attachments are the only source. Skip URLs the
    // other two lists already carry.
    const seenUrls = new Set([
      ...recentMedia.map((m) => m.url),
      ...sentImages.map((s) => s.url),
    ]);
    recentAttachments = getRecentAttachments(threadID, 5).filter(
      (a) => a.url && !seenUrls.has(a.url)
    );
  }
  return {
    attachments: allAttachments,
    recentMedia,
    sentImages,
    recentAttachments,
    // Facts are gathered on EVERY turn, not only when nothing readable
    // is attached: the user asks for a fact on a plain text turn, and
    // the agent needs the list exactly then to pick a fresh one.
    givenFacts: getRecentGivenFacts(threadID, 10),
    replyToText: event.messageReply?.body,
  };
}
