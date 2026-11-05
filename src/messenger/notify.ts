import { MessengerClient } from "./types.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

/**
 * Sends a private background notification strictly to SELF_THREAD_ID.
 * Never sends notifications to group threads.
 */
export async function sendSelfNotification(client: MessengerClient, message: string): Promise<boolean> {
  const selfId = config.selfThreadId;
  if (!selfId) {
    logger.warn({ message }, "Cannot send self notification: SELF_THREAD_ID is not configured");
    return false;
  }

  try {
    await client.sendMessage(message, selfId);
    return true;
  } catch (err: any) {
    logger.error({ err: err.message, selfId }, "Failed to send notification to SELF_THREAD_ID");
    return false;
  }
}
