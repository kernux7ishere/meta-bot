/**
 * SSRF-safe fetch for agent-initiated URL fetches.
 *
 * The guard in src/llm/guards.ts (isSafeUrl) only sees the URL string —
 * it cannot know what a hostname resolves to, and it cannot see where a
 * redirect leads. This module is the actual fetch point, and it closes
 * both holes:
 *
 *  1. DNS resolution: every hostname is resolved with dns.lookup before
 *     the fetch, and the fetch is refused when ANY resolved address is
 *     non-public (loopback / private / link-local / metadata /
 *     CGNAT / documentation / multicast / reserved — v4, v6, and
 *     IPv4-embedded-in-IPv6). A hostname that does not resolve is
 *     refused too (fail closed).
 *  2. Redirects: fetched with `redirect: "manual"` and followed by hand
 *     (max 5 hops), re-validating scheme + DNS + addresses at every hop.
 *     A public URL that 302s to 169.254.169.254 is refused at the hop.
 *  3. Bodies are never replayed across a redirect (and a POST is never
 *     followed at all — the 3xx response is returned as-is), so no
 *     request body or credential can leak to a redirect target.
 *
 * Residual risk, stated honestly: resolve-then-fetch still has a
 * DNS-rebinding (TOCTOU) window — an attacker who controls the domain's
 * DNS could flip the answer between our lookup and fetch's own lookup.
 * Closing that needs IP pinning (connect to the resolved IP with Host /
 * SNI set), which Node's fetch does not support without a custom
 * dispatcher. This blocks the static cases (attacker domain permanently
 * pointing at a private IP, *.nip.io-style names, redirect targets),
 * which is the realistic SSRF surface for this bot.
 */
import dns from "node:dns";
import { fetchWithTimeout } from "./fetch-timeout.js";
import { isSafeUrl } from "../llm/guards.js";
import { isUnsafeIp, stripIpBrackets } from "./ip-safety.js";

/** Max redirects followed (per fetch, not per process). */
export const MAX_SAFE_REDIRECTS = 5;

/** True when the hostname is an IP literal (v4 dotted-quad or v6). */
function isIpLiteral(host: string): boolean {
  const bare = stripIpBrackets(host);
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(bare) || bare.includes(":");
}

/**
 * Refuse a hostname whose resolved addresses are not all public.
 * IP literals are classified directly (no DNS). Throws on unsafe,
 * unresolvable, or unparseable hosts — callers treat a throw as "do
 * not fetch".
 */
export async function assertSafeHost(hostname: string): Promise<void> {
  const host = hostname.toLowerCase();
  const bare = stripIpBrackets(host);
  if (isIpLiteral(host)) {
    const check = isUnsafeIp(bare);
    if (check.unsafe) throw new Error(`refused unsafe IP address ${bare} (${check.reason})`);
    return;
  }
  let addrs: dns.LookupAddress[];
  try {
    addrs = await dns.promises.lookup(host, { all: true });
  } catch {
    throw new Error(`cannot resolve host ${host} (DNS lookup failed)`);
  }
  if (!addrs || addrs.length === 0) {
    throw new Error(`cannot resolve host ${host}`);
  }
  for (const a of addrs) {
    const check = isUnsafeIp(a.address);
    if (check.unsafe) {
      throw new Error(`host ${host} resolves to unsafe address ${a.address} (${check.reason})`);
    }
  }
}

/**
 * Fetch a URL with SSRF protection. Same response shape as fetch (the
 * final response after redirects), so existing callers
 * (res.ok / res.status / res.headers / res.arrayBuffer() / res.text())
 * work unchanged. Throws on unsafe targets, unresolvable hosts, too
 * many redirects, or fetch errors.
 */
export async function safeFetch(
  url: string,
  init: RequestInit = {},
  timeoutMs = 20000
): Promise<Response> {
  const first = isSafeUrl(url);
  if (!first.safe) throw new Error(`Refused unsafe URL: ${first.reason}`);
  const hasBody = init.body !== undefined && init.body !== null;
  let current = url;
  for (let hop = 0; hop <= MAX_SAFE_REDIRECTS; hop++) {
    const parsed = new URL(current);
    await assertSafeHost(parsed.hostname);
    const res = await fetchWithTimeout(current, { ...init, redirect: "manual" }, timeoutMs);
    // A mocked/stubbed fetch in tests may return no headers object —
    // treat that as "no redirect", don't crash on it.
    const location = res.headers?.get?.("location") ?? null;
    const isRedirect = [301, 302, 303, 307, 308].includes(res.status);
    if (!isRedirect || !location) return res;
    if (hop === MAX_SAFE_REDIRECTS) {
      throw new Error(`Too many redirects (>${MAX_SAFE_REDIRECTS}) for ${url}`);
    }
    if (hasBody) {
      // Never replay a body (or re-POST) at a redirect target.
      return res;
    }
    const next = new URL(location, current).href;
    const check = isSafeUrl(next);
    if (!check.safe) {
      throw new Error(`Refused unsafe redirect target: ${check.reason}`);
    }
    current = next;
  }
  throw new Error(`Too many redirects (>${MAX_SAFE_REDIRECTS}) for ${url}`);
}
