import { config } from "../config.js";

/** How long the typing indicator should show for a reply of the given
 *  length — simulates a human typing it out. Duration = length / charsPerSec,
 *  clamped to [minMs, maxMs]. */
export function typingDelayMs(replyLength: number): number {
  const ms = (replyLength / config.typing.charsPerSec) * 1000;
  return Math.min(Math.max(ms, config.typing.minMs), config.typing.maxMs);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
