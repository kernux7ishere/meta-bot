import { config } from "../config.js";

/**
 * Splits text into chunks respecting max characters and paragraph/newline boundaries.
 */
export function chunkText(text: string, maxLen: number = config.maxReplyChars): string[] {
  if (!text) return [];
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Look for a paragraph break
    let splitIdx = remaining.lastIndexOf("\n\n", maxLen);
    if (splitIdx === -1 || splitIdx < maxLen * 0.4) {
      // Look for a newline break
      splitIdx = remaining.lastIndexOf("\n", maxLen);
    }
    if (splitIdx === -1 || splitIdx < maxLen * 0.4) {
      // Look for a sentence break
      splitIdx = remaining.lastIndexOf(". ", maxLen);
      if (splitIdx !== -1) splitIdx += 1;
    }
    if (splitIdx === -1 || splitIdx < maxLen * 0.4) {
      // Look for a space
      splitIdx = remaining.lastIndexOf(" ", maxLen);
    }
    if (splitIdx === -1) {
      // Hard cut if no delimiter found
      splitIdx = maxLen;
    }

    const chunk = remaining.slice(0, splitIdx).trim();
    if (chunk) chunks.push(chunk);
    remaining = remaining.slice(splitIdx).trim();
  }

  return chunks;
}

/**
 * Truncates text so that its total length does not exceed maxLength.
 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const suffix = "\n...[truncated]";
  if (maxLength <= suffix.length) {
    return text.slice(0, maxLength);
  }
  return text.slice(0, maxLength - suffix.length) + suffix;
}

/**
 * Sleep for a random jitter duration to look natural
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getRandomDelay(
  min: number = config.minDelayMs,
  max: number = config.maxDelayMs
): number {
  if (min >= max) return min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
