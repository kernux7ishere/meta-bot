/**
 * fetch with a hard timeout. Plain fetch() can hang forever on a stalled
 * connection, which blocks the bot's agent loop indefinitely — a single
 * stuck tool call then silences the bot for that thread. AbortController
 * bounds every outbound fetch so a slow provider fails fast instead.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 20000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
