import { config } from "../config.js";
import { sleep } from "./typing.js";

/** Outbound send pacing (anti-checkpoint, doc §6.3): Meta's risk engine
 *  flags bursts — several messages fired within a second or two — as
 *  automation. A human never sends that fast. Every outgoing message
 *  (text, sticker, file) waits until at least SEND_MIN_GAP_MS has passed
 *  since the previous send finished, plus a random jitter, so sends are
 *  spaced like a person typing. Serialized globally (all threads share
 *  one queue) so cross-thread bursts are spaced too. The queue survives
 *  a failed send — a rejection never stalls later sends. */
let lastSendAt = 0;
let chain: Promise<void> = Promise.resolve();

export async function pacedSend<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const now = Date.now();
    const wait =
      Math.max(0, lastSendAt + config.sendPacing.minGapMs - now) +
      (config.sendPacing.jitterMs > 0 ? Math.random() * config.sendPacing.jitterMs : 0);
    if (wait > 0) await sleep(wait);
    try {
      return await fn();
    } finally {
      lastSendAt = Date.now();
    }
  });
  // Keep the chain alive even when this send rejects.
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/** Random human "reading" delay before an AI reply is sent — mimics the
 *  pause between receiving a message and starting to type. Uniform random
 *  between REPLY_DELAY_MIN_MS and REPLY_DELAY_MAX_MS (0/0 disables). */
export async function humanReplyDelay(): Promise<void> {
  const min = config.replyDelay.minMs;
  const max = Math.max(min, config.replyDelay.maxMs);
  if (max <= 0) return;
  await sleep(min + Math.random() * (max - min));
}
