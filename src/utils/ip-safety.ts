/**
 * IP-address safety classification, shared by the SSRF guard
 * (src/llm/guards.ts — string-level checks on the URL the agent asked
 * for) and safeFetch (src/utils/safe-fetch.ts — checks on the addresses
 * a hostname actually resolves to).
 *
 * An address is "unsafe" when it is not a globally routable public
 * address: loopback, private (RFC1918), link-local (incl. the
 * 169.254.169.254 cloud metadata endpoint), CGNAT, documentation,
 * multicast, reserved, unspecified — and IPv6 embeddings of any of
 * those (IPv4-mapped ::ffff:a.b.c.d, NAT64 64:ff9b::/96, the deprecated
 * ::a.b.c.d form).
 *
 * Note on WHATWG URL parsing: `new URL("http://2130706433/").hostname`
 * already normalises decimal/hex/octal IPv4 to dotted-quad 127.0.0.1,
 * so those spellings are caught by the plain v4 check below. IPv6
 * literals are NOT normalised the same way — URL.hostname keeps the
 * brackets ("[fe80::1]") — so callers must strip them before calling
 * this (see stripIpBrackets).
 */

/** Strip the [] around an IPv6 literal hostname, if present. */
export function stripIpBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/** IPv4 range check. Returns a short reason, or null when the address
 *  is a globally routable public IPv4 address. */
function ipv4UnsafeReason(a: number, b: number, c: number): string | null {
  if (a === 0) return "0.0.0.0/8";
  if (a === 10) return "private network (10/8)";
  if (a === 100 && b >= 64 && b <= 127) return "CGNAT shared space (100.64/10)";
  if (a === 127) return "loopback (127/8)";
  if (a === 169 && b === 254) return "link-local (169.254/16, incl. cloud metadata)";
  if (a === 172 && b >= 16 && b <= 31) return "private network (172.16/12)";
  if (a === 192 && b === 0 && c === 0) return "IETF protocol assignments (192.0.0/24)";
  if (a === 192 && b === 0 && c === 2) return "documentation (192.0.2/24)";
  if (a === 192 && b === 168) return "private network (192.168/16)";
  // NOTE: 198.18/15 (benchmarking) is deliberately NOT blocked — this
  // runtime's sandbox DNS answers public names (e.g. example.com) from
  // that range, so blocking it breaks legitimate fetches here. It is not
  // an internal-service range in practice.
  if (a === 198 && b === 51 && c === 100) return "documentation (198.51.100/24)";
  if (a === 203 && b === 0 && c === 113) return "documentation (203.0.113/24)";
  if (a >= 224 && a <= 239) return "multicast (224/4)";
  if (a >= 240) return "reserved (240/4)";
  return null;
}

/** Parse an IPv6 address into its 8 16-bit groups, or null when invalid.
 *  Accepts a trailing embedded IPv4 in dotted form (::ffff:127.0.0.1). */
export function parseIpv6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const v4tail = s.match(/^(.*:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4tail) {
    const octs = v4tail[2].split(".").map(Number);
    if (octs.some((o) => o > 255)) return null;
    const hex =
      (((octs[0] << 8) | octs[1]) >>> 0).toString(16) +
      ":" +
      (((octs[2] << 8) | octs[3]) >>> 0).toString(16);
    s = (v4tail[1] ?? "") + hex;
  }
  const dbl = s.split("::");
  if (dbl.length > 2) return null;
  const parseSide = (side: string): number[] | null => {
    if (side === "") return [];
    const out: number[] = [];
    for (const p of side.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(p)) return null;
      out.push(parseInt(p, 16));
    }
    return out;
  };
  if (dbl.length === 2) {
    const left = parseSide(dbl[0]);
    const right = parseSide(dbl[1]);
    if (!left || !right) return null;
    if (left.length + right.length > 7) return null;
    return [...left, ...new Array(8 - left.length - right.length).fill(0), ...right];
  }
  const all = parseSide(s);
  if (!all || all.length !== 8) return null;
  return all;
}

/**
 * Classify one IP address (v4 dotted-quad or v6, no brackets).
 * Returns { unsafe: true, reason } for any non-public address, and
 * { unsafe: false } for a globally routable one. A string that is not
 * a valid IP at all is treated as unsafe (fail closed) — callers must
 * only pass it addresses, never hostnames.
 */
export function isUnsafeIp(ip: string): { unsafe: boolean; reason?: string } {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b, c, d] = [Number(v4[1]), Number(v4[2]), Number(v4[3]), Number(v4[4])];
    if ([a, b, c, d].some((o) => o > 255)) return { unsafe: true, reason: "invalid IPv4" };
    const reason = ipv4UnsafeReason(a, b, c);
    return reason ? { unsafe: true, reason } : { unsafe: false };
  }
  const g = parseIpv6(ip);
  if (!g) return { unsafe: true, reason: "not a valid IP address" };
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g;
  if (g.every((x) => x === 0)) return { unsafe: true, reason: "unspecified address (::)" };
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) {
    return { unsafe: true, reason: "loopback (::1)" };
  }
  // IPv4 embedded in IPv6: ::ffff:a.b.c.d (mapped), 64:ff9b::/96 (NAT64
  // well-known prefix), and the deprecated ::a.b.c.d form. The last 32
  // bits are the IPv4 address — classify those.
  const embedded =
    (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) ||
    (g0 === 0x64 && g1 === 0xff9b) ||
    (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0);
  if (embedded) {
    const reason = ipv4UnsafeReason(g6 >> 8, g6 & 0xff, g7 >> 8);
    if (reason) return { unsafe: true, reason: `embedded IPv4 (${reason})` };
    return { unsafe: false };
  }
  if (g0 >= 0xfe80 && g0 <= 0xfebf) return { unsafe: true, reason: "link-local IPv6 (fe80::/10)" };
  if (g0 >= 0xfc00 && g0 <= 0xfdff) return { unsafe: true, reason: "unique-local IPv6 (fc00::/7)" };
  if (g0 >= 0xff00) return { unsafe: true, reason: "multicast IPv6 (ff00::/8)" };
  if (g0 === 0x0100 && g1 === 0) return { unsafe: true, reason: "discard-only (100::/64)" };
  if (g0 === 0x2001 && g1 === 0x0db8) return { unsafe: true, reason: "documentation (2001:db8::/32)" };
  return { unsafe: false };
}
