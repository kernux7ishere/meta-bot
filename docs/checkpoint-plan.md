# Checkpoint plan — reduce the chance Facebook flags the bot

Sources: the deep-research PDF "Tránh Checkpoint Bot Facebook Messenger"
(`~/workspace/user/files/Tr_nh_Checkpoint_Bot_Facebook_Messenger_0_q89f.pdf`,
2026-11-11) + the checkpoint research of 2026-11-07
(`/tmp/meta-checkpoint-research.md`). This doc is the applied version:
what the PDF says, what is already true of our stack, what code was
changed, and what the user must (not) do.

## What happened (2026-11-07)

- 09:45 UTC: Facebook invalidated the session (401). Re-login via
  `login-interactive.py` succeeded but the fresh session was rejected
  again (401), then inbox load failed with "checkpoint required".
- ~20:00 +07: Facebook RESTRICTED the spare account (Luminous Marble):
  "Bạn không thể tạo nhiều phiên" (cannot create multiple sessions),
  ends **8 Nov 2026**. Reason: suspected "collecting sensitive
  information or sharing malware" (cybersecurity) — a generic automated
  template, not a human finding of malware. Many innocuous accounts get
  the same label.
- Restriction ≠ checkpoint: a checkpoint is identity verification
  (pass it and continue); this restriction is a timed ~24h penalty
  that is NOT lifted by completing a checkpoint. It lifts on the date
  or (sometimes) after a one-shot review. Do NOT retry logins during
  it (can extend it). Do NOT create a new account to bypass.

## The risk signals (ranked) and our status

| Signal (PDF §1–3 + research) | Our status |
|---|---|
| **Datacenter IP (strongest)** — AWS/Lightsail ASN is "trivially identifiable", "instant checkpoint" | **Open.** Bot egresses from Lightsail Sydney. Mitigation: residential Vietnam IP via proxy — see `proxy-plan.md` (Option A WireGuard preferred, Option B SOCKS5 via SSH reverse tunnel). The PDF adds: a **mobile 4G/5G proxy (CGNAT)** is even higher-trust than residential. |
| **Geographic mismatch / session fragmentation** — same session used from two distant locations = "stolen cookie" → invalidation | **User rule (below).** Never log into the spare account from the phone/another device while the bot holds the session. |
| **TLS fingerprint (JA4) mismatch** — UA says Chrome but ClientHello hashes to Node.js/Go | **Already handled by messagix.** Verified in source 2026-11-11: `httpclient/http.go` uses uTLS `HelloChrome_120` for the WebSocket (forced HTTP/1.1 ALPN) and `req.ImpersonateChrome()` for all HTTP clients (GraphQL, upload, LS sync). Caveat: profile is Chrome 120 (~2024) while current Chrome is 141 — a stale profile is a minor signal; do NOT fork messagix to bump it (high risk, no evidence it matters). |
| **HTTP/2 fingerprint** — SETTINGS, WINDOW_UPDATE, pseudo-header order | **Handled by the same impersonation** (`req.ImpersonateChrome()` sets Chrome's HTTP/2 profile). |
| **Passive OS fingerprint (p0f)** — TTL/window mismatch with declared OS | **Consistent.** We declare Chrome on Linux; the TCP stack IS Linux (TTL 64). No mismatch. |
| **MQTT telemetry gap** — official apps stream typing/scroll/presence; bots stay silent then burst | **Partially handled.** Typing indicator while thinking + typing-time delay in "user" mode; reaction on trigger. No fake background presence heartbeat (a rigid periodic signal could itself be detectable; messagix's bridge doesn't do one either). |
| **Behavior: bursts + instant replies** — several messages in 1–2s, replies the same millisecond | **Fixed in code 2026-11-11** (see below). |
| **Frequent re-logins / session churn** — each login is a risk event | **User rule:** after 8/11, log in ONCE and leave the session alone. |
| **Shared / previously-burned IP** — IP-to-account graphs are permanent | **Friend's IP risk** (proxy plan): if the bot is flagged again, the friend's own Facebook use from that IP can be checkpointed more. Explicit agreement required. |

## Code changes applied 2026-11-11 (deployed, service still stopped)

`src/messenger/send-pacing.ts` (new) + wiring in both clients and the
router. Config in `src/config.ts`, documented in `.env.example`.

1. **Outbound send pacing** — every outgoing message (text, sticker,
   file) waits until ≥ `SEND_MIN_GAP_MS` (default 1500) has passed since
   the previous send, plus random jitter up to `SEND_JITTER_MS`
   (default 1000). One global queue across all threads, so cross-thread
   bursts are spaced too. A failed send never stalls the queue. This
   also spaces multi-chunk replies. (Fixes the observed "3 pings in
   2 seconds" burst pattern.)
2. **Human "reading" delay** — random pause between
   `REPLY_DELAY_MIN_MS` (800) and `REPLY_DELAY_MAX_MS` (2500) before an
   AI reply is sent. In "user" typing mode it happens before the typing
   indicator starts (read → type); in "bot" mode before the reply is
   sent (no more instant replies). 0/0 disables.
3. Existing protections kept: inbound per-user rate limit (5/min),
   typing simulation in "user" mode (length / 10 chars/s, clamped
   1–30s), contextual reactions at 30% (not every message).

Tests: `tests/unit-test.ts` §21b verifies pacing (spacing ≥ minGap,
queue survives a failed send, delay in range). All tests pass.

## Presence — "Active now" (added 2026-11-11, deployed, live)

Sidecar reports app state (`socket.ReportAppStateTask`, queue
`ls_presence_report_app_state`). **Since 2026-11-11 ~22:00 +07, ON is
AUTO, not 24/7:** FOREGROUND while there was activity (any inbound
message or outbound send) within `SIDECAR_PRESENCE_IDLE` (default
**10 min**), BACKGROUND after longer silence — like a real user who
put the phone down. Re-decided on (re)connect, on `.presence on`,
on any activity (immediate flip back), and by a ~1-min loop tick
(FOREGROUND re-reported every ~5 min while active). Control:
`.presence on|off` (owner-only, persists in `bot.db`,
default on). Live-verified with a 1-min idle window: FOREGROUND on
connect 14:57:19 UTC, BACKGROUND "inactive after idle" 15:00:31 UTC.
Two gotchas found live: (1) the task is STATEFUL — it must go through
`ExecuteTasks`, `ExecuteStatelessTask` rejects it ("tried to execute
stateful task 123 as stateless"); (2) sidecar stderr surfaces in the
journal only at `LOG_LEVEL=debug` (Node forwards it at debug level).
Trade-off, stated plainly: presence makes the account look human,
but 24/7 FOREGROUND is itself a mild bot signal (a human sleeps) —
which is exactly why ON is now auto-idle instead of always-on.
`.presence off` exists for that reason.

## Rules for the user (not code — these matter as much as the code)

1. **One session, one IP.** While the bot runs, do NOT open the spare
   account (Luminous Marble) on the phone or any other device from a
   different IP. The same session from Vietnam (phone) + Sydney
   (Lightsail) reads as a stolen cookie → session invalidation.
   - Creating the sticker group needs the spare account: do it while
     the bot is STOPPED, and accept that one login from the phone is a
     (small) fragmentation event. Prefer doing it from the same IP the
     bot will use, if practical.
2. **Warm-up after 8/11.** After re-login, start light: only direct
   triggers, no bursts, no mass testing for the first 24–48h. Let the
   new session earn trust before heavy activity. Do NOT immediately
   re-run the 3-pings-in-2-seconds style tests.
3. **Keep the session alive.** Do not re-login unless the session is
   actually dead. Every fresh login is a new risk event.
4. **Keep 2FA on** (already enabled for the spare account).
5. **No parallel testing from the phone.** When testing the bot, send
   test messages from the MAIN account only; do not also drive the
   spare account from the phone at the same time.

## Recovery sequence (after 8 Nov 2026)

1. User runs `python3 ~/login-interactive.py` on Lightsail ONCE
   (username paleuyhsg@mozmail.com, password hidden, 2FA totp).
2. I restart `messenger-userbot.service`, verify "Bot listening",
   "socket connected", "E2EE client ready", no 401.
3. Warm-up (rule 2 above) for 24–48h.
4. If re-login immediately re-triggers a checkpoint, the account is on
   a watchlist — deploy the residential-IP proxy (`proxy-plan.md`)
   BEFORE the next login attempt.

## What NOT to do

- Do NOT chase JA4/TLS spoofing libraries (curl-impersonate etc.) —
  messagix already impersonates Chrome via uTLS for every connection.
- Do NOT use a commercial VPN or shared proxy pool — shared IPs carry
  other users' abuse history and are flagged as proxy/VPN ranges.
- Do NOT add a fake periodic presence heartbeat — no evidence it helps,
  and a rigid schedule is itself a bot signal.
- Do NOT use anti-detect browsers / stealth plugins for this bot — they
  patch the JS runtime, not the network layer, and the bot has no
  browser at all.
