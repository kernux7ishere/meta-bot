/**
 * Format an agent failure into a specific, debuggable message for the chat,
 * so a bug surfaces where the user can see it instead of the bot going
 * silent. Includes everything needed to diagnose it: which step failed
 * (when the error carries that context), the HTTP status / error code,
 * the error name, and the message. Timeouts get called out explicitly
 * (they're the common case).
 *
 * Examples:
 * - "⚠️ Bot lỗi [LLM • HTTP 429 • RateLimitError]: ..."
 * - "⚠️ Bot lỗi [tool search_web • AbortError]: quá thời gian chờ ..."
 */
export function formatAgentError(err: any): string {
  const msg = (err?.message || String(err)).trim();
  const name = err?.name || "";
  const status = err?.status ? `HTTP ${err.status}` : "";
  const code = err?.code && err.code !== "ECONNABORTED" ? err.code : "";
  const step = err?.step || "";
  const parts = [step, status, code, name].filter(Boolean);
  const where = parts.length > 0 ? ` [${parts.join(" • ")}]` : "";
  const isTimeout =
    /timeout|timed out|abort/i.test(msg) ||
    /timeout|abort/i.test(name) ||
    err?.code === "ECONNABORTED";
  if (isTimeout) {
    return `⚠️ Bot lỗi${where}: quá thời gian chờ (${msg}). Gửi lại tin nhắn để thử lại nhé.`;
  }
  return `⚠️ Bot lỗi${where}: ${msg}`;
}
