import { IncomingEvent, MessengerClient } from "./messenger/types.js";
import { config } from "./config.js";
import { logger } from "./utils/logger.js";
import { db } from "./db/index.js";
import { commands } from "./commands/index.js";
import { learnStyleFromMessages } from "./llm/style-learning.js";
import { sendSelfNotification } from "./messenger/notify.js";
import { reactToTrigger } from "./messenger/react.js";
import { recordAttachments, recordMessageLink } from "./recent-attachments.js";
import { gatherAgentContext } from "./agent-context.js";
import { scanOutgoingText } from "./llm/guards.js";
import { defaultRateLimiter } from "./utils/rate-limiter.js";
import { runAgent } from "./llm/agent.js";
import { chunkText } from "./utils/text.js";
import { formatAgentError } from "./utils/agent-error.js";
import { typingDelayMs, sleep } from "./messenger/typing.js";
import { humanReplyDelay } from "./messenger/send-pacing.js";

/** Is the given message id a bot message? Checks bot_messages first; falls
 *  back to the messages table (a bot message sent before bot_messages
 *  recording, or by an external script, still shows the bot as its sender). */
async function isReplyToBotMessage(threadId: string, replyToId: string, botUserId: string): Promise<boolean> {
  if (await db.isBotMessage(replyToId)) return true;
  try {
    const recent = await db.getRecentMessages(threadId, 50);
    const target = recent.find((m) => m.id === replyToId);
    return !!target && target.sender_id === botUserId;
  } catch {
    return false;
  }
}

/** Run the agent for one triggering message and send the answer back as a
 *  threaded reply (first chunk quotes the triggering message). Typing-indicator
 *  work mode (per thread, `.typing`): 'bot' = no indicator, reply fast (the
 *  default); 'user' = show the typing indicator while the bot thinks and
 *  "types" the reply out, with the typing time proportional to the reply
 *  length. If the agent fails (LLM timeout, tool error, ...), the error is
 *  sent to the thread directly so it can be seen and fixed, instead of the
 *  bot going silent. */
async function sendAiReply(client: MessengerClient, event: IncomingEvent, senderName?: string): Promise<void> {
  const { threadID, senderID, messageID, body = "" } = event;
  // Instant visual feedback while the LLM thinks (fire-and-forget).
  // The emoji is picked from the message content (diverse, contextual).
  reactToTrigger(client, messageID, threadID, body);
  // Shared context: current + replied-to attachments (reply chain),
  // recent media, bot-sent images, recent files (see agent-context.ts).
  const ctx = await gatherAgentContext(client, event);
  const { attachments: allAttachments, recentMedia, sentImages, recentAttachments, givenFacts } = ctx;
  // Typing-indicator work mode for this thread ('bot' = fast, no indicator;
  // 'user' = show typing while thinking and "typing" the reply out).
  const typingMode = await db.getTypingMode(threadID).catch(() => "bot" as const);
  let stopTyping: (() => void) | null = null;
  if (typingMode === "user") {
    // Human pause (anti-checkpoint, doc §6.3): read the message before
    // starting to type — a person never starts typing the same millisecond
    // a message arrives.
    await humanReplyDelay();
    stopTyping = await client.sendTypingIndicator(threadID);
  }
  const stop = () => {
    stopTyping?.();
    stopTyping = null;
  };
  let answer: string;
  try {
    answer = await runAgent({
      threadId: threadID,
      senderId: senderID,
      senderName,
      messageText: body,
      attachments: allAttachments,
      recentMedia,
      sentImages,
      recentAttachments,
      givenFacts,
      replyToText: event.messageReply?.body,
      client,
    });
  } catch (err: any) {
    logger.error({ err: err.message, threadID }, "Agent run failed");
    stop();
    try {
      await client.sendMessage(formatAgentError(err), threadID, messageID, senderID);
    } catch (sendErr: any) {
      logger.error({ err: sendErr?.message, threadID }, "Failed to send error message to thread");
    }
    return;
  }
  if (!answer || !answer.trim()) {
    stop();
    logger.warn({ threadID }, "Agent returned empty response");
    return;
  }
  // CODE-LEVEL OUTGOING SCAN (Hermes-style secret redaction): the final
  // answer is checked for secrets before it is sent. If it carries one,
  // the raw text never leaves the bot — send a safe refusal instead.
  // The scan logs only the secret *type*, never the secret itself.
  const secretLabels = scanOutgoingText(answer);
  if (secretLabels.length > 0) {
    logger.error({ threadID, secrets: secretLabels }, "Outgoing answer blocked: contains a secret");
    stop();
    await client.sendMessage(
      "Mình không thể gửi câu trả lời này vì nó chứa thông tin nhạy cảm (mã/khóa bí mật). Bạn thử hỏi lại theo cách khác nhé.",
      threadID,
      messageID,
      senderID
    );
    return;
  }
  // 'user' mode: keep the typing indicator on for a duration proportional to
  // the reply length (simulates typing it out), then stop it and send.
  // 'bot' mode: no indicator — instead take a short human "reading" pause
  // before firing the reply, so answers never go out the instant the LLM
  // finishes (instant replies are a bot signal, doc §6.3).
  if (typingMode === "user") {
    await sleep(typingDelayMs(answer.length));
  } else {
    await humanReplyDelay();
  }
  stop();
  const chunks = chunkText(answer);
  for (let i = 0; i < chunks.length; i++) {
    await client.sendMessage(chunks[i], threadID, i === 0 ? messageID : undefined, i === 0 ? senderID : undefined);
  }
}

/** Record one event's attachments (files/photos + sticker-as-attachment)
 *  into the recent-attachments store. Shared by the normal message path
 *  and the late `message_attachments` path. */
function recordEventAttachments(event: IncomingEvent): void {
  const { threadID, senderID, messageID } = event;
  const recordable = [...(event.attachments || [])];
  if (event.stickerID && event.stickerUrl) {
    recordable.push({
      type: "sticker",
      url: event.stickerUrl,
      name: `sticker ${event.stickerID}`,
    });
  }
  if (recordable.length > 0) {
    try {
      recordAttachments(threadID, recordable, senderID, messageID);
    } catch (err: any) {
      logger.warn({ err: err.message }, "Failed to record message attachments");
    }
  }
}

export async function routeIncomingEvent(client: MessengerClient, event: IncomingEvent): Promise<void> {
  const { type, threadID, senderID, messageID, body = "" } = event;

  // Late attachments: the sidecar emits these when attachment/sticker
  // rows arrive in a table AFTER their message was already emitted —
  // just record them and stop. Not a new message: no reply, no learning,
  // no commands. senderID is "" here (the LS row carries no sender),
  // so this runs before the sender check below.
  if (type === "message_attachments") {
    if (threadID && messageID) recordEventAttachments(event);
    return;
  }

  // Only handle standard message events
  if (type !== "message" && type !== "message_reply") {
    return;
  }

  // Safety: Ignore empty or non-existent message IDs
  if (!messageID || !threadID || !senderID) {
    return;
  }

  // Dedup: MQTT can redeliver the same message (especially around a
  // reconnect), and processing it twice used to send duplicate replies.
  // The claim lives in SQLite (seen_messages), not a RAM Set: the Set
  // lost everything on restart and dropped ALL ids when it hit its 1000
  // cap and cleared. Runs AFTER the message_attachments branch above —
  // a late-attachments event shares its message's id and must never be
  // mistaken for a duplicate.
  if (!(await db.claimMessageSeen(messageID, threadID))) return;

  const currentBotUserId = client.getCurrentUserID();
  const ownerId = config.ownerId || currentBotUserId;

  // Reply-chain link: record that this message replied to another, BEFORE
  // the bot-echo filter below — a chain can pass through a bot message
  // (user replies to the bot's reply to a file), and the link is about
  // the thread, not the sender. Used by resolveReplyChainAttachments.
  if (event.messageReply?.messageID) {
    try {
      recordMessageLink(threadID, messageID, event.messageReply.messageID);
    } catch (err: any) {
      logger.warn({ err: err.message }, "Failed to record reply link");
    }
  }

  // The Go sidecar echoes the bot's own sent messages back as incoming
  // events (they appear in the LS table). Never process them: the bot
  // replying to itself is a loop — it mentions itself, the reply/@mention
  // trigger fires on its own message, it replies to its own reply, and so
  // on. (In the future main-account "user mode" this needs revisiting,
  // because there the bot's id IS the owner's id and the owner's own
  // phone messages must still be processed; for the spare-account setup
  // the ids differ, so this is safe.)
  if (currentBotUserId && senderID === currentBotUserId) {
    return;
  }

  const isFromOwner = senderID === ownerId;

  // Recent-attachments memory: record every incoming message's
  // attachments (files, photos, ...) per thread, so a follow-up in the
  // NEXT message ("đọc file này", "mô tả nó") can resolve to the file
  // that was just sent. The bot's own echoes are filtered out above,
  // so its own sends are never recorded here (sent images have their
  // own store). Any sender counts — a group member's file matters too.
  // A sticker is recorded as a pseudo-attachment too (type "sticker",
  // url = its image URL): stickers arrive as sticker_id/sticker_url, NOT
  // in `attachments`, so without this a reply to a sticker ("mô tả
  // sticker này") resolves to nothing — proven 2026-11-11.
  recordEventAttachments(event);

  // Sticker learning (C + D): when the OWNER sends a sticker, record it in
  // the sticker pack with the surrounding text as context — that is how
  // the bot learns which sticker the owner uses for which feeling, from
  // any thread and from the sticker-learning group alike. This is passive
  // learning only: it never forces a sticker reply (the agent decides
  // when a sticker fits, via send_sticker). The bot's own stickers are
  // already filtered out above (sender == bot id).
  if (isFromOwner && event.stickerID) {
    try {
      const { learnSticker } = await import("./sticker-pack.js");
      const context = body.trim() || event.messageReply?.body || "";
      const entry = learnSticker(event.stickerID, context, threadID);
      logger.info(
        { stickerId: event.stickerID, name: entry.name, threadId: threadID },
        "Learned sticker from owner"
      );
      // Semantic memory (waku-style): describe the sticker with vision
      // + embed the description, so send_sticker can later find it by
      // meaning instead of by a hand-written tag. Fire-and-forget —
      // never blocks the reply. Needs the sticker image URL (absent for
      // animated stickers, which stay ID-only in the pack).
      if (event.stickerUrl) {
        import("./sticker-vec.js")
          .then((m) => m.describeAndEmbedSticker(event.stickerID!, event.stickerUrl!, threadID))
          .catch((err: any) =>
            logger.warn({ err: err.message }, "Sticker describe/embed failed")
          );
      }
    } catch (err: any) {
      logger.warn({ err: err.message }, "Failed to learn sticker from owner");
    }
  }

  // 1. Check if the message is a command from the owner (starts with '.')
  const trimmedBody = body.trim();
  if (isFromOwner && trimmedBody.startsWith(".")) {
    const parts = trimmedBody.slice(1).trim().split(/\s+/);
    const commandName = parts[0]?.toLowerCase();
    const args = parts.slice(1);

    logger.info({ commandName, args, threadID }, "Owner issued dot-command");

    const handler = commands.get(commandName);
    if (handler) {
      try {
        await handler({
          client,
          event,
          args,
          rawText: trimmedBody,
        });
      } catch (err: any) {
        logger.error({ err: err.message, commandName }, "Command execution failed");
        await client.sendMessage(`Lỗi thực thi lệnh .${commandName}: ${err.message}`, threadID, messageID);
      }
    } else {
      logger.debug({ commandName }, "Unknown dot-command, ignoring");
    }

    return;
  }

  // If the owner typed manually (without dot), record message and check auto_learn
  if (isFromOwner) {
    logger.debug({ threadID, messageID }, "Owner sent manual non-command message.");

    // Store owner message into D1 history
    await db.saveMessage({
      id: messageID,
      thread_id: threadID,
      sender_id: senderID,
      sender_name: "Owner",
      body: body,
      reply_to_id: event.messageReply?.messageID || null,
      created_at: event.timestamp || Date.now(),
    });

    // Check auto_learn for this thread
    db.getThreadStyle(threadID).then(async (style) => {
      if (!style.auto_learn) {
        return; // No-op when auto is off
      }

      const newCount = (style.owner_msgs_since_learn || 0) + 1;
      if (newCount >= config.autoLearnEvery) {
        // Trigger background learning
        // Auto-learn reuses the source set from the last manual .persona save run. If none exists, it uses owner messages only.
        const sourcesToUse =
          style.sources && style.sources.length > 0 ? style.sources : [ownerId];

        learnStyleFromMessages(threadID, ownerId, config.autoLearnEvery, sourcesToUse, client)
          .then(async (result) => {
            await db.setThreadStyle(threadID, {
              content: result.style,
              sources: result.sources,
              owner_msgs_since_learn: 0,
            });
            logger.info(
              { thread_id: threadID, new_style_length: result.style.length },
              "Auto-learn updated thread style"
            );
            // Notify owner via self-chat
            await sendSelfNotification(
              client,
              ` [Auto-learn] Đã tự động cập nhật phong cách cho đoạn chat ${threadID} (độ dài: ${result.style.length} ký tự).`
            );
          })
          .catch((err) => {
            logger.error({ err: err.message, threadId: threadID }, "Auto-learn background task failed");
            sendSelfNotification(
              client,
              ` [Auto-learn Lỗi] Cập nhật phong cách tự động cho đoạn chat ${threadID} thất bại: ${err.message}`
            );
          });
      } else {
        await db.setThreadStyle(threadID, { owner_msgs_since_learn: newCount });
      }
    }).catch((err) => {
      logger.error({ err: err.message, threadID }, "Failed to update owner message counter for auto_learn");
    });

    // Owner replying to one of the bot's own messages, or @mentioning the
    // bot, is a conversation turn — answer it with the AI when AI is on
    // for this thread. (Previously only reply-to-bot was checked here, so
    // an owner's @mention was silently ignored.)
    const threadSettings = await db.getThreadSettings(threadID);
    let isReplyToBot = false;
    if (event.messageReply?.senderID === currentBotUserId) {
      // Go sidecar reports the replied-to sender directly (ReplyToUserId),
      // so no history lookup is needed.
      isReplyToBot = true;
    } else if (event.messageReply?.messageID) {
      isReplyToBot = await isReplyToBotMessage(threadID, event.messageReply.messageID, currentBotUserId);
    }
    let mentionsBot = false;
    if (event.mentions) {
      mentionsBot = Object.keys(event.mentions).includes(currentBotUserId);
    }
    if (threadSettings.ai_enabled && (isReplyToBot || mentionsBot)) {
      try {
        await sendAiReply(client, event, "Owner");
      } catch (err: any) {
        logger.error({ err: err.message, threadID }, "Error during owner auto-reply");
      }
    }

    return;
  }

  // 2. Fetch sender information & store message into history. The name
  // cache (sender_names, fed by the sidecar member list) is checked
  // first: under Go, message events carry ids only and getUserInfo
  // returns {}, so without the cache history rows — and namesFromHistory
  // for @mentions — end up nameless.
  let senderName: string | undefined;
  try {
    senderName = (await db.getSenderName(senderID)) || undefined;
  } catch {
    // ignore — fall through to getUserInfo
  }
  if (!senderName) {
    try {
      const info = await client.getUserInfo(senderID);
      senderName = info.name;
      if (senderName) {
        await db.cacheSenderNames([{ senderId: senderID, name: senderName }]).catch(() => {});
      }
    } catch {
      // ignore
    }
  }

  await db.saveMessage({
    id: messageID,
    thread_id: threadID,
    sender_id: senderID,
    sender_name: senderName || null,
    body: body,
    reply_to_id: event.messageReply?.messageID || null,
    created_at: event.timestamp || Date.now(),
  });

  // 3. Check access control for senderID:
  // Effective check, in this order:
  // 1. Owner: always allowed (already handled above; if from owner, it was handled).
  // 2. Global blacklist: blocked.
  // 3. Thread mode: apply whitelist or blacklist rules.
  const globalBlacklist = await db.getGlobalBlacklist();
  if (globalBlacklist.includes(senderID)) {
    logger.debug({ senderID, threadID }, "User is on global blacklist. Ignoring triggers and messages.");
    return;
  }

  const accessData = await db.getAccessList(threadID);
  if (accessData.access_mode === "blacklist") {
    if (accessData.blacklist.includes(senderID)) {
      logger.debug({ senderID, threadID }, "User is on thread blacklist. Ignoring triggers and messages.");
      return;
    }
  } else if (accessData.access_mode === "whitelist") {
    if (!accessData.whitelist.includes(senderID)) {
      logger.debug({ senderID, threadID }, "User is not on thread whitelist. Ignoring triggers.");
      return;
    }
  }

  // 4. Check if AI is enabled for this thread
  const threadSettings = await db.getThreadSettings(threadID);
  if (!threadSettings.ai_enabled) {
    // AI is OFF for this thread, and not owner command -> stay silent
    return;
  }

  // 4. Check trigger conditions when AI is ON:
  // Condition A: Replied to a message sent by the bot
  let isReplyToBot = false;
  if (event.messageReply?.senderID === currentBotUserId) {
    // Go sidecar reports the replied-to sender directly (ReplyToUserId).
    isReplyToBot = true;
  } else if (event.messageReply && event.messageReply.messageID) {
    const replyTargetId = event.messageReply.messageID;
    isReplyToBot = await isReplyToBotMessage(threadID, replyTargetId, currentBotUserId);
  }

  // Condition B: Mentions/tags the owner account
  let mentionsOwner = false;
  if (event.mentions) {
    const mentionedIds = Object.keys(event.mentions);
    mentionsOwner = mentionedIds.includes(ownerId) || mentionedIds.includes(currentBotUserId);
  }

  if (!isReplyToBot && !mentionsOwner) {
    // Not triggered -> stay silent
    return;
  }

  logger.info(
    { threadID, senderID, isReplyToBot, mentionsOwner },
    "Trigger condition matched. Preparing auto-reply..."
  );

  // 5. Rate limiting check
  const rateLimit = defaultRateLimiter.checkAndIncrement(senderID);
  if (!rateLimit.allowed) {
    logger.warn({ senderID, threadID }, "User hit rate limit, ignoring message");
    return;
  }

  // 6. Run the agent and reply (sendAiReply adds a short human "reading"
  // pause before sending, and the client spaces outgoing sends).
  try {
    await sendAiReply(client, event, senderName);
  } catch (err: any) {
    logger.error({ err: err.message, threadID }, "Error during auto-reply generation");
  }
}
