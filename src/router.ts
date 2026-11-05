import { IncomingEvent, MessengerClient } from "./messenger/types.js";
import { config } from "./config.js";
import { logger } from "./utils/logger.js";
import { db } from "./db/index.js";
import { commands } from "./commands/index.js";
import { learnStyleFromMessages } from "./commands/learn.js";
import { sendSelfNotification } from "./messenger/notify.js";
import { defaultRateLimiter } from "./utils/rate-limiter.js";
import { runAgent } from "./llm/agent.js";
import { chunkText, sleep, getRandomDelay } from "./utils/text.js";

export async function routeIncomingEvent(client: MessengerClient, event: IncomingEvent): Promise<void> {
  const { type, threadID, senderID, messageID, body = "" } = event;

  // Only handle standard message events
  if (type !== "message" && type !== "message_reply") {
    return;
  }

  // Safety: Ignore empty or non-existent message IDs
  if (!messageID || !threadID || !senderID) {
    return;
  }

  const currentBotUserId = client.getCurrentUserID();
  const ownerId = config.ownerId || currentBotUserId;
  const isFromOwner = senderID === ownerId || senderID === currentBotUserId;

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
        // Auto-learn reuses the source set from the last manual .learn run. If none exists, it uses owner messages only.
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

    return;
  }

  // 2. Fetch sender information & store message into D1 history
  let senderName: string | undefined;
  try {
    const info = await client.getUserInfo(senderID);
    senderName = info.name;
  } catch {
    // ignore
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
  if (event.messageReply && event.messageReply.messageID) {
    const replyTargetId = event.messageReply.messageID;
    isReplyToBot = await db.isBotMessage(replyTargetId);
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

  // 6. Natural delay + typing indicator
  const stopTyping = await client.sendTypingIndicator(threadID);

  try {
    const delay = getRandomDelay();
    await sleep(delay);

    const attachments = (event.attachments || []).map((att) => ({
      url: att.url || att.previewUrl || "",
      type: att.type || "file",
    }));

    const replyToText = event.messageReply?.body;

    const answer = await runAgent({
      threadId: threadID,
      senderId: senderID,
      senderName,
      messageText: body,
      attachments,
      replyToText,
    });

    stopTyping();

    if (!answer || !answer.trim()) {
      logger.warn({ threadID }, "Agent returned empty response");
      return;
    }

    const chunks = chunkText(answer);
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) await sleep(600);
      await client.sendMessage(chunks[i], threadID, i === 0 ? messageID : undefined);
    }
  } catch (err: any) {
    stopTyping();
    logger.error({ err: err.message, threadID }, "Error during auto-reply generation");
  }
}
