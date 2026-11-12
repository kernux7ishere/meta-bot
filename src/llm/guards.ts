/**
 * Code-level safety guards for the Messenger agent.
 *
 * Modelled on the Hermes Agent approach (NousResearch/hermes-agent):
 *  - Pure detection functions live here — no LLM calls, no state, no
 *    config reads at call time. The agent loop only *calls* them.
 *  - Two tiers, like Hermes's HARDLINE vs DANGEROUS patterns:
 *      HARDLINE: always blocked, no override (secrets, SSRF, injection
 *      payloads in write-tool arguments). A floor below any "yolo".
 *      TAINT-GATED: stricter rules once the turn has read untrusted
 *      content (airlock-style taint tracking).
 *  - The prompt (soul.md) is only the first layer. These guards are the
 *    enforcement: even if the LLM ignores the prompt or is tricked by an
 *    injection in a web page / file / image, the dangerous call never runs.
 *
 * What is guarded here (the bot's real action surface):
 *  - Outbound sends (send_image / send_file / send_sticker): confined to
 *    the current thread by construction; the guard blocks secrets and
 *    injection payloads in their arguments.
 *  - Memory writes (remember): the highest-risk persistent action — a
 *    poisoned memory affects every future conversation. Blocked on any
 *    secret, injection pattern, or (when tainted) URL in the note.
 *  - URL fetches (read_url / read_image / read_file / send_image /
 *    send_file / reverse_image_search): SSRF guard — private /
 *    loopback / link-local / metadata addresses and non-http(s)
 *    schemes are refused at the guard, and safeFetch re-checks the
 *    resolved addresses plus every redirect hop at fetch time.
 *  - The final answer: scanned for secrets before it is sent to the
 *    thread (secret redaction, Hermes-style).
 *
 * Fail-closed on detection, fail-open on guard errors: if a guard itself
 * throws, the tool call is blocked (a broken guard must not become a
 * bypass). A timeout or an unreachable service is never treated as
 * approval — the same rule Hermes's airlock fix (GHSA-mgf8-gh7g-q4rg)
 * established.
 */

import { isUnsafeIp, stripIpBrackets } from "../utils/ip-safety.js";

export interface GuardVerdict {
  allowed: boolean;
  /** Short, safe reason (never contains the secret/injection text itself). */
  reason?: string;
}

/** Tools that write persistent state or send content out of the bot.
 *  send_message / remind are here too: their text goes straight to the
 *  thread (now or later), so an instruction smuggled into untrusted
 *  content must not be able to steer them either. */
const WRITE_TOOLS = new Set(["remember", "record_fact", "send_image", "send_file", "send_sticker", "send_message", "remind"]);

/** Tools that fetch a URL supplied (directly or indirectly) by the LLM. */
const URL_TOOLS: Record<string, string[]> = {
  read_url: ["url"],
  read_image: ["url"],
  read_file: ["url"],
  send_image: ["url"],
  send_file: ["url"],
  reverse_image_search: ["image_url"],
};

/**
 * Secret patterns, Hermes-style (their redaction engine covers 35+ token
 * prefixes). Only high-confidence shapes are listed here — a specific
 * prefix + length — so ordinary chat text is not flagged.
 */
const SECRET_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /sk-[A-Za-z0-9]{20,}/, label: "OpenAI-style API key" },
  { re: /sk-(live|test)-[A-Za-z0-9]{10,}/, label: "Stripe-style secret key" },
  { re: /rk-(live|test)-[A-Za-z0-9]{10,}/, label: "Stripe restricted key" },
  { re: /ghp_[A-Za-z0-9]{20,}/, label: "GitHub personal access token" },
  { re: /gho_[A-Za-z0-9]{20,}/, label: "GitHub OAuth token" },
  { re: /github_pat_[A-Za-z0-9_]{10,}/, label: "GitHub fine-grained token" },
  { re: /AKIA[0-9A-Z]{16}/, label: "AWS access key" },
  { re: /xox[baprs]-[A-Za-z0-9-]{10,}/, label: "Slack token" },
  { re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, label: "private key" },
  { re: /\b\d{6,7}:[A-Za-z0-9_-]{30,}\b/, label: "Telegram bot token" },
  { re: /hf_[A-Za-z0-9]{20,}/, label: "Hugging Face token" },
  { re: /glpat-[A-Za-z0-9_-]{10,}/, label: "GitLab token" },
  { re: /ya29\.[A-Za-z0-9_-]{10,}/, label: "Google OAuth token" },
  { re: /AIza[0-9A-Za-z_-]{20,}/, label: "Google API key" },
  { re: /-----BEGIN CERTIFICATE-----/, label: "certificate" },
  // Generic "key = value" assignments with a long, high-entropy value.
  { re: /(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*['"]?[A-Za-z0-9_\-./+]{16,}['"]?/i, label: "credential assignment" },
];

/**
 * Prompt-injection signatures. Checked against TOOL ARGUMENTS (not against
 * user chat text, and never against tool results — results are data).
 * A write-tool argument carrying one of these is almost certainly echoing
 * an instruction smuggled in through untrusted content.
 */
const INJECTION_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /ignore (all |any )?(previous|prior|above|earlier) (instructions?|prompts?|rules?|directions?)/i, label: "ignore-previous-instructions" },
  { re: /disregard (all |any )?(previous|prior|above|earlier)/i, label: "disregard-previous" },
  { re: /system\s*override/i, label: "system-override" },
  { re: /you are now (a|an|the)\b/i, label: "you-are-now" },
  { re: /new instructions?:/i, label: "new-instructions" },
  { re: /do not follow (the )?(previous|above|system)/i, label: "do-not-follow" },
  { re: /(reveal|print|show|output|repeat) (your |the )?(system )?(instructions?|prompt|rules?)/i, label: "reveal-instructions" },
  { re: /jailbreak/i, label: "jailbreak" },
  { re: /developer mode/i, label: "developer-mode" },
  { re: /act as (a|an|the) (system|admin|root|developer)\b/i, label: "act-as-privileged" },
  { re: /bypass (the )?(safety|guard|filter|restriction)/i, label: "bypass-safety" },
  { re: /send (this|that|it|the) (to|in) (another|a different|other)/i, label: "send-elsewhere" },
];

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) collectStrings(v, out);
  }
  return out;
}

/** Find secret patterns in a text. Returns the matched labels only (never the secret itself). */
export function findSecrets(text: string): string[] {
  const labels: string[] = [];
  for (const { re, label } of SECRET_PATTERNS) {
    if (re.test(text)) labels.push(label);
  }
  return labels;
}

/** Find prompt-injection signatures in a text. Returns the matched labels only. */
export function findInjection(text: string): string[] {
  const labels: string[] = [];
  for (const { re, label } of INJECTION_PATTERNS) {
    if (re.test(text)) labels.push(label);
  }
  return labels;
}

/**
 * SSRF guard for URLs the agent wants to fetch (Hermes-style URL safety).
 * String-level only: refuses non-http(s) schemes, the localhost name,
 * and IP-literal hosts that classify as non-public (loopback, private
 * RFC1918, link-local incl. the 169.254.169.254 cloud metadata endpoint,
 * CGNAT, documentation, multicast, reserved — v4, v6, and IPv4 embedded
 * in IPv6). Public hostnames are allowed here — DNS resolution is the
 * fetcher's job (safeFetch resolves and checks every answer); this is
 * the cheap pre-check that runs before any tool executes.
 */
export function isSafeUrl(raw: string): { safe: boolean; reason?: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { safe: false, reason: "not a valid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { safe: false, reason: `scheme ${url.protocol} is not allowed` };
  }
  const host = url.hostname.toLowerCase();
  if (host === "localhost") {
    return { safe: false, reason: "localhost is not allowed" };
  }
  // IP-literal hosts. URL.hostname keeps the brackets on IPv6 literals
  // ("[fe80::1]") — strip them first, or the prefix checks below never
  // match (that bug used to let [fe80::1] / [fd00::1] /
  // [::ffff:127.0.0.1] through). WHATWG URL parsing already normalises
  // decimal/hex/octal IPv4 spellings to dotted-quad, so the classifier
  // sees the real address.
  const bare = stripIpBrackets(host);
  const isLiteral = /^(\d{1,3}\.){3}\d{1,3}$/.test(bare) || bare.includes(":");
  if (isLiteral) {
    const check = isUnsafeIp(bare);
    if (check.unsafe) return { safe: false, reason: `${check.reason} is not allowed` };
  }
  return { safe: true };
}

export interface ToolCallCheckOptions {
  /** True once this turn has read untrusted content (web/file/image/search). */
  tainted: boolean;
  /** The thread the turn is running in — sends must stay here. */
  threadId: string;
}

/**
 * The single guard entry point for the agent loop (Hermes's
 * `check_all_command_guards` equivalent). Inspects a tool call BEFORE it
 * runs. Returns allow/block with a short safe reason. A blocked call is
 * reported back to the LLM as a tool result so it can explain, not executed.
 */
export function checkToolCall(
  toolName: string,
  args: unknown,
  opts: ToolCallCheckOptions
): GuardVerdict {
  const argStrings = collectStrings(args);
  const joined = argStrings.join("\n");

  // HARDLINE 1 — secrets must never flow into a tool argument (exfiltration
  // path: a secret pasted into a search query, a filename, a note...).
  const secrets = findSecrets(joined);
  if (secrets.length > 0) {
    return { allowed: false, reason: `blocked: argument contains a secret (${secrets[0]})` };
  }

  // HARDLINE 2 — SSRF: refuse unsafe fetch targets.
  const urlFields = URL_TOOLS[toolName] || [];
  if (urlFields.length > 0 && args && typeof args === "object") {
    for (const field of urlFields) {
      const value = (args as Record<string, unknown>)[field];
      if (typeof value === "string" && value.trim()) {
        const check = isSafeUrl(value.trim());
        if (!check.safe) {
          return { allowed: false, reason: `blocked: unsafe URL (${check.reason})` };
        }
      }
    }
  }

  // HARDLINE 3 — injection payloads in write-tool arguments. A note, a
  // filename, or a send query carrying an instruction is echoing smuggled
  // content, not the user's request.
  if (WRITE_TOOLS.has(toolName)) {
    const injections = findInjection(joined);
    if (injections.length > 0) {
      return { allowed: false, reason: `blocked: argument carries an instruction (${injections[0]})` };
    }
  }

  // TAINT-GATED (airlock-style) — once this turn has read untrusted
  // content, memory writes get stricter: a note must be a plain fact/rule,
  // never a URL (a URL in a note is how a poisoned fact smuggles a link
  // the bot would later quote or fetch). Normal notes have no URLs.
  if (opts.tainted && (toolName === "remember" || toolName === "record_fact")) {
    if (/https?:\/\/\S+/i.test(joined)) {
      return { allowed: false, reason: "blocked: memory note must not contain a URL after reading untrusted content" };
    }
  }

  // HARDLINE 4 — sends are confined to the current thread. The tools take
  // their target from context.threadId, but verify the call isn't trying
  // to name another thread.
  if (toolName.startsWith("send_")) {
    const threadFields = ["thread_id", "threadId", "target_thread"];
    if (args && typeof args === "object") {
      for (const f of threadFields) {
        const v = (args as Record<string, unknown>)[f];
        if (typeof v === "string" && v && v !== opts.threadId) {
          return { allowed: false, reason: "blocked: sends are confined to the current thread" };
        }
      }
    }
  }

  return { allowed: true };
}

/**
 * Scan the agent's final answer before it is sent to the thread
 * (Hermes-style secret redaction, enforced in code). Returns the labels of
 * any secrets found. The caller must NOT send the raw text when labels are
 * non-empty — it must refuse or redact first.
 */
export function scanOutgoingText(text: string): string[] {
  return findSecrets(text);
}
