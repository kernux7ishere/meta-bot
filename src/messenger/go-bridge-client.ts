// Node.js client for the Go Messenger sidecar (mautrix/meta).
//
// The sidecar is the single Messenger client for BOTH regular groups
// (lightspeed socket session) AND E2EE DMs (whatsmeow-based E2EE client).
// It speaks JSON-lines over stdin/stdout: one JSON command object per line
// in, one JSON event/response object per line out; human logs go to stderr.
//
// Protocol (see ~/workspace/messenger-sidecar/TEST-REPORT.md):
//   Commands: ping, version, status,
//             login_cookies {cookies?}, login_password {username, password},
//             login_input {input}, send {thread_id, text, is_e2ee, reply_to?, mentions?},
//             send_file {thread_id, file_path, filename, mime_type, text?, reply_to?},
//             typing {thread_id, is_typing, is_group},
//             react {thread_id, message_id, reaction},
//             members {thread_id}, disconnect.
//   Events:   message {thread_id, sender_id, message_id, text, is_e2ee,
//             timestamp_ms, is_own, mentions?, reply_to?, reply_to_sender_id?},
//             connected, disconnected, logged_in,
//             login_input_required {step_id, instructions, fields},
//             e2ee_ready, sent {otid}, error {error}.
//   A response to a command carries the command's `id`; async events
//   (message, connected, ...) carry no `id`.
//
// This module implements the same MessengerClient interface as the
// fca-unofficial client (src/messenger/client.ts) so the router works
// unchanged. Gaps vs fca (sidecar has no such commands yet):
//   - getUserInfo / getThreadHistory: return {} / [] (no sidecar command).
//   - E2EE send (sendE2EE) has no reply/quote support yet; E2EE replies go
//     out as plain messages. send_file and stickers are plain threads only.
//
// Which threads are E2EE is learned from incoming messages: a thread that
// delivers a message with is_e2ee=true is remembered, and later sends to
// it go out with is_e2ee=true.
//
// The sidecar process is supervised: if it crashes/exits it is restarted
// with backoff (up to maxRestarts). If the bot was logged in, the restart
// tries to restore the saved session (login_cookies with no cookies =
// reuse the cookies saved on disk by the sidecar).
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { db } from "../db/index.js";
import type { IncomingEvent, MessengerAttachment, MessengerClient } from "./types.js";
import { pacedSend } from "./send-pacing.js";

/** Lightsail path of the sidecar binary (built 2026-11-06). */
export const DEFAULT_SIDECAR_PATH = "/home/admin/messenger-sidecar/messenger-sidecar";

export interface SidecarStatus {
  connected: boolean;
  logged_in: boolean;
  user_id: number;
  e2ee_ready: boolean;
  /** True while the sidecar reports FOREGROUND ("Active now"). */
  presence_active?: boolean;
}

export interface LoginInputRequest {
  stepId: string;
  instructions?: string;
  fields: string[];
}

export type LoginResult =
  | { ok: true; userId: number; needsInput: false }
  | { ok: true; needsInput: true; step: LoginInputRequest };

export interface GoBridgeOptions {
  /** Binary path. Default: GO_SIDECAR_PATH env, else the Lightsail path
   *  when it exists, else ./messenger-sidecar (local dev). */
  sidecarPath?: string;
  /** Extra argv for the sidecar (tests run the mock via node: path=node,
   *  args=[mock-sidecar.mjs]). */
  sidecarArgs?: string[];
  /** Passed through as SIDECAR_STATE_DIR to the sidecar. */
  stateDir?: string;
  /** Try to restore a saved session on (re)spawn. Default true. */
  autoRelogin?: boolean;
  /** Max automatic restarts after a crash. Default 10. */
  maxRestarts?: number;
  /** First restart delay (ms), doubled each attempt. Default 1000. */
  restartBaseDelayMs?: number;
  /** Cap for the restart delay (ms). Default 30000. */
  restartMaxDelayMs?: number;
  /** How long the Messenger socket may stay down before the client
   *  restarts the sidecar (ms). Default: config SIDECAR_SOCKET_DOWN_RESTART_MS (60000).
   *  Only armed while logged in — before login the socket is down by
   *  design. Covers the 2026-11-07 failure: a 401 disconnect with the
   *  sidecar process still alive used to leave the bot deaf/mute until
   *  someone restarted it by hand. */
  socketDownRestartMs?: number;
}

export interface GoBridgeClient extends MessengerClient {
  /** Low-level escape hatch: send any sidecar command, resolve with the
   *  response event. Used by tests and by future commands (history, ...). */
  sendCommand(cmd: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, any>>;
  getVersion(): Promise<{ version: string; go: string }>;
  getStatus(): Promise<SidecarStatus>;
  /** Log in with cookies (empty/absent = reuse the cookies the sidecar
   *  saved on disk). Resolves with the user id, or with needsInput when
   *  the sidecar asks for a 2FA/checkpoint step. */
  loginCookies(cookies?: Record<string, string>): Promise<LoginResult>;
  /** Log in with username/password. May resolve with needsInput (2FA /
   *  checkpoint) — continue with sendLoginInput. */
  loginPassword(username: string, password: string): Promise<LoginResult>;
  /** Continue a password login that asked for input. */
  sendLoginInput(input: Record<string, string>): Promise<LoginResult>;
  /** True when this thread is known to be E2EE (learned from an incoming
   *  E2EE message, or set manually). */
  isE2EEThread(threadID: string): boolean;
  markE2EEThread(threadID: string, isE2EE?: boolean): void;
  /** Stop the sidecar process. */
  disconnect(): Promise<void>;
}

interface Pending {
  resolve: (evt: Record<string, any>) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  cmd: string;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const SEND_TIMEOUT_MS = 65_000;
const LOGIN_TIMEOUT_MS = 180_000;

/** Build sidecar mention refs from [{user_id | userID, name}] by locating
 *  each display name in the message text. Messenger counts offsets/lengths
 *  in UTF-16 code units, which is what JS string indices are, so indexOf
 *  lines up. A mention whose name is not found in the text is skipped
 *  (it would ping nobody). */
function computeMentionRefs(
  text: string,
  mentions: Array<{ user_id?: any; userID?: any; name?: string }>
): Array<{ user_id: number; offset: number; length: number }> {
  const refs: Array<{ user_id: number; offset: number; length: number }> = [];
  // Matches fca-unofficial's buildMentionData (the reference for native
  // mentions): the mention span covers ONLY the display name, NOT the "@".
  // The "@" is just the trigger character; Facebook expects offset to
  // point at the name itself and length to be the name's length. Including
  // the "@" in the span makes the mention render as plain text instead of
  // a native (highlighted, tappable, notifying) mention.
  // A cursor tracks position so two people with the same display name get
  // different offsets (each search starts after the previous mention).
  // UNITS: Facebook's mention offsets/lengths are UTF-8 BYTE offsets into
  // the message text — NOT JS string (UTF-16) indices. For ASCII they are
  // identical, but a Vietnamese name like "Dương Tuấn Phong" is 16 UTF-16
  // units and 18 UTF-8 bytes; sending 16 makes Facebook see a span that
  // stops mid-name ("Dương Tuấn Pho"), so it does not recognise the mention
  // and never emits the "mentioned you" notification (the message still
  // arrives as a plain group notification). Search with JS indexOf, then
  // convert the found UTF-16 position to bytes with Buffer.byteLength.
  let cursor = 0;
  for (const m of mentions) {
    const id = Number(m.user_id ?? m.userID);
    const name = typeof m.name === "string" ? m.name : "";
    if (!Number.isSafeInteger(id) || id <= 0 || !name) continue;
    // Prefer "@Name" (offset skips the "@"), fall back to a bare "Name".
    let at = text.indexOf("@" + name, cursor);
    let offsetUtf16 = -1;
    if (at >= 0) {
      offsetUtf16 = at + 1;
    } else {
      offsetUtf16 = text.indexOf(name, cursor);
    }
    if (offsetUtf16 < 0) continue;
    const offset = Buffer.byteLength(text.slice(0, offsetUtf16));
    const length = Buffer.byteLength(name);
    refs.push({ user_id: id, offset, length });
    cursor = offsetUtf16 + name.length;
  }
  return refs;
}

function resolveSidecarPath(options: GoBridgeOptions): string {
  if (options.sidecarPath) return options.sidecarPath;
  if (config.goSidecarPath) return config.goSidecarPath;
  if (fs.existsSync(DEFAULT_SIDECAR_PATH)) return DEFAULT_SIDECAR_PATH;
  return path.resolve(process.cwd(), "messenger-sidecar");
}

function toLoginResult(evt: Record<string, any>): LoginResult {
  if (evt.event === "login_input_required") {
    return {
      ok: true,
      needsInput: true,
      step: {
        stepId: String(evt.step_id ?? ""),
        instructions: typeof evt.instructions === "string" ? evt.instructions : undefined,
        fields: Array.isArray(evt.fields) ? evt.fields.map(String) : [],
      },
    };
  }
  return { ok: true, needsInput: false, userId: Number(evt.user_id ?? 0) };
}

class GoBridgeClientImpl implements GoBridgeClient {
  private readonly sidecarPath: string;
  private readonly sidecarArgs: string[];
  private readonly autoRelogin: boolean;
  private readonly maxRestarts: number;
  private readonly restartBaseDelayMs: number;
  private readonly restartMaxDelayMs: number;
  private readonly socketDownRestartMs: number;
  private readonly stateDir: string | undefined;

  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutRl: readline.Interface | null = null;
  private stderrRl: readline.Interface | null = null;
  private readonly pending = new Map<string, Pending>();
  private idCounter = 0;
  private messageCallback: ((err: any, event: IncomingEvent) => void) | null = null;
  private currentUserId = "";
  private readonly e2eeThreads = new Set<string>();
  private wasLoggedIn = false;
  private restartAttempts = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private dead = false;
  /** Messenger socket state (watchdog, §34). */
  private socketConnected = false;
  private socketDownTimer: NodeJS.Timeout | null = null;

  constructor(sidecarPath: string, options: GoBridgeOptions) {
    this.sidecarPath = sidecarPath;
    this.sidecarArgs = options.sidecarArgs ?? [];
    this.autoRelogin = options.autoRelogin !== false;
    this.maxRestarts = options.maxRestarts ?? 10;
    this.restartBaseDelayMs = options.restartBaseDelayMs ?? 1000;
    this.restartMaxDelayMs = options.restartMaxDelayMs ?? 30_000;
    this.socketDownRestartMs = options.socketDownRestartMs ?? config.socketDownRestartMs ?? 60_000;
    this.stateDir = options.stateDir || config.goSidecarStateDir || undefined;
  }

  // ---------- lifecycle ----------

  async start(): Promise<void> {
    this.spawnProcess();
    // Handshake: prove the child speaks the JSON-lines protocol.
    await this.sendCommand("ping", {}, 10_000);
    const version = await this.getVersion();
    logger.info(
      { sidecar: this.sidecarPath, version: version.version, go: version.go },
      "Go Messenger sidecar connected"
    );
    const status = await this.getStatus().catch(() => null);
    if (status) {
      logger.info({ status }, "Go sidecar status");
      if (status.connected) this.socketConnected = true;
      if (status.logged_in && status.user_id) {
        this.currentUserId = String(status.user_id);
        this.wasLoggedIn = true;
      }
    }
    if (this.autoRelogin) {
      // Best effort: restore a session the sidecar saved on disk. Not
      // awaited — a fresh install has no saved cookies and login happens
      // later via loginCookies()/loginPassword().
      this.loginCookies().then(
        (r) => {
          if (!r.needsInput) logger.info({ userId: r.userId }, "Go sidecar session restored from saved cookies");
        },
        (err) => {
          logger.info({ err: err.message }, "Go sidecar has no saved session yet (login required)");
        }
      );
    }
  }

  private spawnProcess(): void {
    const env = { ...process.env };
    if (this.stateDir) env.SIDECAR_STATE_DIR = this.stateDir;
    const child = spawn(this.sidecarPath, this.sidecarArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    this.child = child;
    // Never let a dead child's stream errors crash the bot.
    child.stdin.on("error", () => {});
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});

    this.stdoutRl = readline.createInterface({ input: child.stdout });
    this.stdoutRl.on("line", (line) => this.handleStdoutLine(line));
    this.stderrRl = readline.createInterface({ input: child.stderr });
    this.stderrRl.on("line", (line) => {
      logger.debug({ sidecar: line }, "sidecar log");
    });

    child.on("error", (err) => {
      logger.error({ err: err.message, sidecar: this.sidecarPath }, "Failed to spawn Go sidecar");
    });
    child.on("exit", (code, signal) => {
      this.child = null;
      this.stdoutRl?.close();
      this.stderrRl?.close();
      this.stdoutRl = null;
      this.stderrRl = null;
      this.clearSocketDownTimer();
      this.rejectAllPending(new Error(`Go sidecar exited (code ${code ?? "?"}${signal ? `, signal ${signal}` : ""})`));
      if (this.stopping) {
        logger.info("Go sidecar stopped");
        return;
      }
      this.scheduleRestart();
    });
  }

  // ---------- socket watchdog (§34) ----------
  // A crash restarts the sidecar (see scheduleRestart), but a socket
  // disconnect with the process still alive does NOT — the bot used to
  // sit deaf/mute after a 401 until someone restarted it by hand
  // (2026-11-07). While logged in, a `disconnected` event arms a timer;
  // a `connected` event clears it. If the socket stays down past the
  // deadline, kill the sidecar — the exit handler then restarts it
  // through the normal backoff path (bounded by maxRestarts).

  private clearSocketDownTimer(): void {
    if (this.socketDownTimer) {
      clearTimeout(this.socketDownTimer);
      this.socketDownTimer = null;
    }
  }

  private armSocketDownTimer(): void {
    this.clearSocketDownTimer();
    if (this.stopping || this.dead || this.socketDownRestartMs <= 0) return;
    this.socketDownTimer = setTimeout(() => this.onSocketDownTooLong(), this.socketDownRestartMs);
  }

  private onSocketDownTooLong(): void {
    this.socketDownTimer = null;
    if (this.stopping || this.dead || this.socketConnected) return;
    logger.error(
      { downMs: this.socketDownRestartMs },
      "Go sidecar socket stayed down too long, restarting the sidecar"
    );
    const child = this.child;
    if (!child) return; // already restarting via the exit path
    child.kill("SIGTERM");
    setTimeout(() => {
      if (this.child === child && !child.killed) child.kill("SIGKILL");
    }, 2000);
  }

  private scheduleRestart(): void {
    this.restartAttempts++;
    if (this.restartAttempts > this.maxRestarts) {
      this.dead = true;
      const err = new Error(
        `Go sidecar crashed and automatic restarts are exhausted (${this.maxRestarts} attempts). ` +
          `The bot cannot send/receive Messenger messages until it is restarted.`
      );
      logger.error({ err: err.message }, "Go sidecar restarts exhausted");
      this.emitListenerError(err);
      return;
    }
    const delay = Math.min(
      this.restartBaseDelayMs * 2 ** (this.restartAttempts - 1),
      this.restartMaxDelayMs
    );
    logger.warn(
      { attempt: this.restartAttempts, maxRestarts: this.maxRestarts, delayMs: delay },
      "Go sidecar exited, restarting..."
    );
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping) return;
      this.spawnProcess();
      // A successful handshake resets the restart counter; a failed one
      // leaves it counting (the next exit schedules the next backoff).
      this.sendCommand("ping", {}, 10_000).then(
        () => {
          this.restartAttempts = 0;
          logger.info("Go sidecar restarted and answering again");
          if (this.autoRelogin && this.wasLoggedIn) {
            this.loginCookies().then(
              (r) => {
                if (!r.needsInput) logger.info({ userId: r.userId }, "Go sidecar session restored after restart");
              },
              (err) => logger.warn({ err: err.message }, "Go sidecar could not restore its session after restart")
            );
          }
        },
        (err) => logger.warn({ err: err.message }, "Restarted Go sidecar did not answer ping")
      );
    }, delay);
  }

  private emitListenerError(err: Error): void {
    if (this.messageCallback) {
      try {
        this.messageCallback(err, null as unknown as IncomingEvent);
      } catch {}
    }
  }

  private rejectAllPending(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  async disconnect(): Promise<void> {
    this.stopping = true;
    this.clearSocketDownTimer();
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    if (child) {
      // Best effort: tell the sidecar to drop its socket/E2EE sessions
      // before we kill the process. (sendCommand still allows the
      // "disconnect" command while stopping.)
      try {
        await this.sendCommand("disconnect", {}, 5000);
      } catch {}
      if (this.child === child) {
        child.kill("SIGTERM");
        // Give it a moment to exit, then force it.
        await new Promise((r) => setTimeout(r, 500));
        if (this.child === child && !child.killed) child.kill("SIGKILL");
      }
    }
    this.rejectAllPending(new Error("Go bridge client disconnected"));
    this.messageCallback = null;
  }

  // ---------- JSON-lines protocol ----------

  async sendCommand(cmd: string, params: Record<string, unknown> = {}, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS): Promise<Record<string, any>> {
    if (this.dead) {
      throw new Error("Go sidecar is not running (automatic restarts exhausted). Restart the bot to try again.");
    }
    // The "disconnect" command is allowed while stopping (disconnect()
    // sends it to ask the sidecar to drop its sessions before the kill).
    if (this.stopping && cmd !== "disconnect") {
      throw new Error("Go bridge client is shutting down.");
    }
    await this.waitForChild(Math.min(timeoutMs, 10_000));
    const child = this.child;
    if (!child) {
      throw new Error("Go sidecar is not running (restarting?). Try again in a moment.");
    }
    const id = `c${++this.idCounter}`;
    const payload = JSON.stringify({ id, cmd, ...params });
    return new Promise<Record<string, any>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Sidecar command "${cmd}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, cmd });
      child.stdin.write(payload + "\n", (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Error(`Failed to write "${cmd}" to Go sidecar: ${err.message}`));
        }
      });
    });
  }

  private async waitForChild(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.child && !this.dead && !this.stopping && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  private handleStdoutLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let evt: Record<string, any>;
    try {
      evt = JSON.parse(trimmed);
    } catch (err: any) {
      logger.warn({ line: trimmed.slice(0, 500), err: err.message }, "Go sidecar sent a non-JSON stdout line");
      return;
    }
    // A response to a command carries the command's id.
    if (typeof evt.id === "string" && this.pending.has(evt.id)) {
      const p = this.pending.get(evt.id)!;
      this.pending.delete(evt.id);
      clearTimeout(p.timer);
      if (evt.event === "error" || evt.ok === false) {
        p.reject(new Error(typeof evt.error === "string" ? evt.error : `Sidecar command "${p.cmd}" failed`));
      } else {
        p.resolve(evt);
      }
      // A login_* response that also reports the user id means we are in.
      if (typeof evt.user_id === "number" && evt.user_id !== 0) {
        this.currentUserId = String(evt.user_id);
        this.wasLoggedIn = true;
      }
      return;
    }
    this.handleAsyncEvent(evt);
  }

  // Parse the sidecar's attachment list ({type, url, preview_url, name,
  // mime, size}) into MessengerAttachment objects, dropping entries with
  // neither a URL nor a name. Shared by the `message` and
  // `message_attachments` events.
  private parseSidecarAttachments(raw: unknown): MessengerAttachment[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((a) => a && typeof a === "object")
      .map((a) => ({
        type: String((a as any).type || "file"),
        url: typeof (a as any).url === "string" ? (a as any).url : "",
        previewUrl:
          typeof (a as any).preview_url === "string" ? (a as any).preview_url : undefined,
        name: typeof (a as any).name === "string" ? (a as any).name : undefined,
        mime: typeof (a as any).mime === "string" ? (a as any).mime : undefined,
        size: typeof (a as any).size === "number" ? (a as any).size : undefined,
      }))
      .filter((a) => a.url || a.name);
  }

  private handleAsyncEvent(evt: Record<string, any>): void {
    switch (evt.event) {
      case "message": {
        const threadID = String(evt.thread_id ?? "");
        const senderID = String(evt.sender_id ?? "");
        const messageID = String(evt.message_id ?? "");
        if (!threadID || !senderID || !messageID) {
          logger.warn({ evt }, "Go sidecar sent a message event without ids");
          return;
        }
        if (evt.is_e2ee === true) this.e2eeThreads.add(threadID);
        const incoming: IncomingEvent = {
          type: "message",
          threadID,
          senderID,
          messageID,
          body: typeof evt.text === "string" ? evt.text : "",
          timestamp: typeof evt.timestamp_ms === "number" ? evt.timestamp_ms : Date.now(),
          // Attachments the sender attached (photo/file/video/audio with a
          // direct download URL, filename and mime). The sidecar reads
          // them from the LS table; without them the agent can never see
          // a file a user sent (read_file takes a URL).
          attachments: this.parseSidecarAttachments(evt.attachments),
          isE2EE: evt.is_e2ee === true,
        };
        // @mentions: sidecar sends a list of mentioned user ids.
        if (Array.isArray(evt.mentions) && evt.mentions.length > 0) {
          const mentions: Record<string, string> = {};
          for (const id of evt.mentions) {
            const key = String(id);
            if (key && key !== "0") mentions[key] = key;
          }
          if (Object.keys(mentions).length > 0) incoming.mentions = mentions;
        }
        // Reply: sidecar sends the id of the message being replied to and
        // its sender, so the router can tell a reply-to-bot apart from an
        // ordinary message without a history lookup.
        if (typeof evt.reply_to === "string" && evt.reply_to) {
          incoming.messageReply = {
            messageID: evt.reply_to,
            senderID:
              evt.reply_to_sender_id !== undefined && evt.reply_to_sender_id !== null
                ? String(evt.reply_to_sender_id)
                : "",
          };
        }
        // Sticker: sidecar sends the attached sticker id (also on
        // sticker-only messages, whose text is empty). The router uses it
        // to learn stickers the owner sends.
        if (evt.sticker_id !== undefined && evt.sticker_id !== null) {
          const sid = String(evt.sticker_id);
          if (sid && sid !== "0") incoming.stickerID = sid;
        }
        // Sticker image URL (same event): the router uses it to describe
        // the sticker with vision for semantic sticker search.
        if (typeof evt.sticker_url === "string" && evt.sticker_url) {
          incoming.stickerUrl = evt.sticker_url;
        }
        this.messageCallback?.(null, incoming);
        return;
      }
      case "message_attachments": {
        // Late attachment/sticker rows: the sidecar emits these when the
        // rows arrive in a table AFTER their message was already emitted
        // (or the message row never carried them). Not a new message —
        // the router just records them so reply-to / follow-up questions
        // can resolve to the file. sender_id is 0 (unknown): the LS
        // attachment row carries no sender.
        const threadID = String(evt.thread_id ?? "");
        const messageID = String(evt.message_id ?? "");
        if (!threadID || !messageID) return;
        const incoming: IncomingEvent = {
          type: "message_attachments",
          threadID,
          senderID:
            evt.sender_id !== undefined &&
            evt.sender_id !== null &&
            String(evt.sender_id) !== "0"
              ? String(evt.sender_id)
              : "",
          messageID,
          attachments: this.parseSidecarAttachments(evt.attachments),
        };
        if (evt.sticker_id !== undefined && evt.sticker_id !== null) {
          const sid = String(evt.sticker_id);
          if (sid && sid !== "0") incoming.stickerID = sid;
        }
        if (typeof evt.sticker_url === "string" && evt.sticker_url) {
          incoming.stickerUrl = evt.sticker_url;
        }
        this.messageCallback?.(null, incoming);
        return;
      }
      case "connected":
        this.socketConnected = true;
        this.clearSocketDownTimer();
        logger.info("Go sidecar: Messenger socket connected");
        return;
      case "disconnected":
        this.socketConnected = false;
        // Only armed while logged in: before login the socket is down
        // by design, and a restart then would kill a healthy sidecar
        // waiting for credentials.
        if (this.wasLoggedIn) this.armSocketDownTimer();
        logger.warn({ error: evt.error || "" }, "Go sidecar: Messenger socket disconnected");
        return;
      case "logged_in":
        if (typeof evt.user_id === "number" && evt.user_id !== 0) {
          this.currentUserId = String(evt.user_id);
          this.wasLoggedIn = true;
          logger.info({ userId: this.currentUserId }, "Go sidecar logged in");
        }
        return;
      case "e2ee_ready":
        logger.info("Go sidecar: E2EE client ready");
        return;
      case "login_input_required":
        logger.warn(
          { stepId: evt.step_id, instructions: evt.instructions, fields: evt.fields },
          "Go sidecar login needs input (2FA/checkpoint)"
        );
        return;
      case "error":
        logger.error({ error: evt.error }, "Go sidecar reported an error");
        return;
      default:
        logger.debug({ evt }, "Go sidecar sent an unhandled event");
    }
  }

  // ---------- MessengerClient interface ----------

  getCurrentUserID(): string {
    return this.currentUserId;
  }

  async sendMessage(
    message: string | { body: string; mentions?: any; attachment?: any; sticker?: string | number },
    threadID: string,
    replyToMessageID?: string,
    replyToSenderID?: string
  ): Promise<string> {
    let text: string;
    let mentionRefs: Array<{ user_id: number; offset: number; length: number }> | undefined;
    if (typeof message === "string") {
      text = message;
    } else {
      if (message.attachment) {
        throw new Error(
          "Go sidecar gửi file/ảnh qua sendFile (cần đường dẫn file tạm), không dùng stream. Dùng client.sendFile thay cho sendMessage có attachment."
        );
      }
      if (message.sticker) {
        const stickerId = Number(message.sticker);
        if (!Number.isSafeInteger(stickerId) || stickerId <= 0) {
          throw new Error(`Invalid sticker id for Go sidecar: ${message.sticker}`);
        }
        // Sticker send: the sidecar sets SendType=STICKER + StickerId.
        const tid = Number(threadID);
        if (!Number.isSafeInteger(tid) || tid <= 0) {
          throw new Error(`Invalid thread id for Go sidecar sticker: ${threadID}`);
        }
        if (this.e2eeThreads.has(threadID)) {
          throw new Error("Go sidecar chưa hỗ trợ gửi sticker trong đoạn chat E2EE (chỉ đoạn chat thường).");
        }
        const res = await pacedSend(() =>
          this.sendCommand(
            "send",
            { thread_id: tid, text: "", is_e2ee: false, sticker_id: stickerId },
            SEND_TIMEOUT_MS
          )
        );
        const otid = String(res.otid ?? "");
        await this.recordOwnMessage(otid, threadID, "[sticker]");
        return otid;
      }
      text = message.body ?? "";
      // @mentions: [{user_id | userID, name}] — find each name in the text
      // and compute its byte offset/length for the sidecar.
      if (Array.isArray(message.mentions) && message.mentions.length > 0) {
        mentionRefs = computeMentionRefs(text, message.mentions);
      }
    }
    if (!text.trim()) {
      throw new Error("Cannot send an empty message via the Go sidecar.");
    }
    const tid = Number(threadID);
    if (!Number.isSafeInteger(tid) || tid <= 0) {
      throw new Error(`Invalid thread id for Go sidecar: ${threadID}`);
    }
    const isE2EE = this.e2eeThreads.has(threadID);
    const sendCmd: Record<string, any> = { thread_id: tid, text, is_e2ee: isE2EE };
    // Quote-reply: the sidecar sets ReplyMetaData on the send task
    // (plain) or QuotedMessage in the E2EE envelope metadata. The
    // sender id becomes the <fbid>@msgr participant; without it the
    // quote carries only the message id.
    if (replyToMessageID) sendCmd.reply_to = replyToMessageID;
    if (replyToSenderID) {
      const sid = Number(replyToSenderID);
      if (Number.isSafeInteger(sid) && sid > 0) sendCmd.reply_to_sender_id = sid;
    }
    if (mentionRefs && mentionRefs.length > 0) sendCmd.mentions = mentionRefs;
    const res = await pacedSend(() => this.sendCommand("send", sendCmd, SEND_TIMEOUT_MS));
    const otid = String(res.otid ?? "");
    await this.recordOwnMessage(otid, threadID, text, replyToMessageID);
    return otid;
  }

  /**
   * Record a message this bot just sent, in BOTH stores: bot_messages
   * (reply-to-bot lookup) and messages (the LLM's history). The sidecar
   * returns an otid, not the real Facebook message id — the echo event
   * carries the real id but no otid, so the two can never be reconciled
   * here; the otid is the row's id. The reply-to-bot check still works
   * because the sidecar reports the replied-to SENDER directly
   * (ReplyToUserId), and only the fallback history lookup needs the
   * real id. Never throws: a failed record must not fail a send that
   * already succeeded.
   */
  private async recordOwnMessage(
    otid: string,
    threadID: string,
    body: string,
    replyToMessageID?: string
  ): Promise<void> {
    if (!otid) return;
    await db.recordBotMessage(otid, threadID).catch((e) => {
      logger.warn({ err: e.message, otid }, "Failed to record sent bot message");
    });
    await db
      .saveMessage({
        id: otid,
        thread_id: threadID,
        sender_id: this.currentUserId,
        sender_name: "Luminous",
        body,
        reply_to_id: replyToMessageID ?? null,
        created_at: Date.now(),
      })
      .catch((e) => {
        logger.warn({ err: e.message, otid }, "Failed to save sent bot message to history");
      });
  }

  /** Send a local file as a MEDIA attachment via the sidecar `send_file`
   *  command (Mercury upload). Plain threads only; E2EE throws. */
  async sendFile(
    filePath: string,
    filename: string,
    mimeType: string,
    threadID: string,
    caption?: string,
    replyToMessageID?: string
  ): Promise<string> {
    const tid = Number(threadID);
    if (!Number.isSafeInteger(tid) || tid <= 0) {
      throw new Error(`Invalid thread id for Go sidecar sendFile: ${threadID}`);
    }
    if (!filePath) {
      throw new Error("sendFile requires a local file path.");
    }
    if (this.e2eeThreads.has(threadID)) {
      throw new Error("Go sidecar chưa hỗ trợ gửi file trong đoạn chat E2EE (chỉ đoạn chat thường).");
    }
    const sendCmd: Record<string, any> = {
      thread_id: tid,
      file_path: filePath,
      filename: filename || "file",
      mime_type: mimeType || "",
      text: caption ?? "",
    };
    if (replyToMessageID) sendCmd.reply_to = replyToMessageID;
    const res = await pacedSend(() => this.sendCommand("send_file", sendCmd, 120_000));
    const otid = String(res.otid ?? "");
    // No caption means the history row would be an empty line — describe
    // what was sent instead (the file itself is not in history).
    const captionText = (caption ?? "").trim();
    const body =
      captionText ||
      (mimeType.startsWith("image/")
        ? "[ảnh]"
        : mimeType.startsWith("video/")
          ? "[video]"
          : mimeType.startsWith("audio/")
            ? "[audio]"
            : `[file: ${filename || "file"}]`);
    await this.recordOwnMessage(otid, threadID, body, replyToMessageID);
    return otid;
  }

  /** List the thread's participants via the sidecar `members` command. */
  async getThreadMembers(threadID: string): Promise<Array<{ userID: string; name?: string }>> {
    const tid = Number(threadID);
    if (!Number.isSafeInteger(tid) || tid <= 0) {
      throw new Error(`Invalid thread id for Go sidecar members: ${threadID}`);
    }
    const res = await this.sendCommand("members", { thread_id: tid }, 30_000);
    const members = Array.isArray(res.members) ? res.members : [];
    const result = members
      .map((m: any) => ({
        userID: String(m.user_id ?? ""),
        name: typeof m.name === "string" && m.name ? m.name : undefined,
      }))
      .filter((m: { userID: string }) => m.userID && m.userID !== "0");
    // Feed the sender-name cache: the member list is the only source
    // that reliably carries names under Go (message events carry ids
    // only). Fire-and-forget — a cache failure must not fail the call.
    const named = result
      .filter((m) => m.name)
      .map((m) => ({ senderId: m.userID, name: m.name as string }));
    if (named.length > 0) {
      void db.cacheSenderNames(named).catch((e) => {
        logger.warn({ err: e.message }, "Failed to cache member names");
      });
    }
    return result;
  }

  async sendTypingIndicator(threadID: string): Promise<() => void> {
    // Messenger hides the indicator ~5s after the last typing event, so
    // re-send every 3s while typing; stop explicitly with is_typing=false.
    // The sidecar needs to know group vs 1:1 for the presence task:
    // E2EE threads are 1:1 (is_group=false); everything else is a group.
    // (Was hardcoded is_group=true, so the indicator never showed in 1:1
    // DMs — the sidecar sent a GROUP_THREAD presence task for a 1:1 thread
    // and Facebook ignored it.)
    const isGroup = !this.e2eeThreads.has(threadID);
    const send = async (isTyping: boolean): Promise<void> => {
      try {
        await this.sendCommand(
          "typing",
          { thread_id: Number(threadID), is_typing: isTyping, is_group: isGroup },
          10_000
        );
      } catch (err) {
        logger.warn({ err, threadID }, "Go sidecar typing command failed");
      }
    };
    await send(true);
    const keepAlive = setInterval(() => {
      void send(true);
    }, 3000);
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      clearInterval(keepAlive);
      void send(false);
    };
  }

  async setMessageReaction(reaction: string, messageID: string, threadID: string): Promise<void> {
    const tid = Number(threadID);
    if (!Number.isSafeInteger(tid) || tid <= 0) {
      throw new Error(`Invalid thread id for Go sidecar reaction: ${threadID}`);
    }
    if (!messageID) return;
    try {
      await this.sendCommand(
        "react",
        { thread_id: tid, message_id: messageID, reaction },
        30_000
      );
    } catch (err: any) {
      // A failed reaction must not break the reply; log and move on.
      logger.warn({ err: err?.message, threadID, messageID }, "Go sidecar react command failed");
    }
  }

  async getUserInfo(_userID: string): Promise<{ name?: string }> {
    // No sidecar command for user lookup yet; the router treats {} as
    // "unknown name" and carries on.
    return {};
  }

  async getThreadHistory(_threadID: string, _amount: number, _timestamp?: number): Promise<any[]> {
    // No sidecar history command yet (the sidecar does not emit the
    // initial table as messages either); recent-media lookup degrades
    // to [] and the agent simply has no recent media.
    return [];
  }

  listen(callback: (err: any, event: IncomingEvent) => void): () => void {
    this.messageCallback = callback;
    return () => {
      if (this.messageCallback === callback) this.messageCallback = null;
    };
  }

  // ---------- login / status helpers ----------

  async getVersion(): Promise<{ version: string; go: string }> {
    const res = await this.sendCommand("version", {}, 10_000);
    return { version: String(res.version ?? ""), go: String(res.go ?? "") };
  }

  async getStatus(): Promise<SidecarStatus> {
    const res = await this.sendCommand("status", {}, 10_000);
    return {
      connected: res.connected === true,
      logged_in: res.logged_in === true,
      user_id: Number(res.user_id ?? 0),
      e2ee_ready: res.e2ee_ready === true,
      presence_active: res.presence_active === true,
    };
  }

  /** Set the account's Active status. Best-effort: a failure is
   *  logged, not thrown — presence must never break startup or a
   *  reply. The sidecar reports FOREGROUND on (re)connect and
   *  refreshes it while enabled, so this mostly matters for turning
   *  it off (and back on). */
  async setPresence(active: boolean): Promise<void> {
    try {
      await this.sendCommand("presence", { active }, 30_000);
    } catch (err: any) {
      logger.warn({ err: err?.message, active }, "Go sidecar presence command failed");
    }
  }

  async loginCookies(cookies?: Record<string, string>): Promise<LoginResult> {
    const params: Record<string, unknown> = {};
    if (cookies && Object.keys(cookies).length > 0) params.cookies = cookies;
    const res = await this.sendCommand("login_cookies", params, LOGIN_TIMEOUT_MS);
    const result = toLoginResult(res);
    if (!result.needsInput && result.userId) {
      this.currentUserId = String(result.userId);
      this.wasLoggedIn = true;
    }
    return result;
  }

  async loginPassword(username: string, password: string): Promise<LoginResult> {
    const res = await this.sendCommand("login_password", { username, password }, LOGIN_TIMEOUT_MS);
    const result = toLoginResult(res);
    if (!result.needsInput && result.userId) {
      this.currentUserId = String(result.userId);
      this.wasLoggedIn = true;
    }
    return result;
  }

  async sendLoginInput(input: Record<string, string>): Promise<LoginResult> {
    const res = await this.sendCommand("login_input", { input }, LOGIN_TIMEOUT_MS);
    const result = toLoginResult(res);
    if (!result.needsInput && result.userId) {
      this.currentUserId = String(result.userId);
      this.wasLoggedIn = true;
    }
    return result;
  }

  isE2EEThread(threadID: string): boolean {
    return this.e2eeThreads.has(threadID);
  }

  markE2EEThread(threadID: string, isE2EE = true): void {
    if (isE2EE) this.e2eeThreads.add(threadID);
    else this.e2eeThreads.delete(threadID);
  }
}

/** Spawn the Go sidecar and return a MessengerClient backed by it.
 *  Login is NOT required here: the client answers ping/version/status
 *  before any login, and (when autoRelogin is on) tries to restore a
 *  session the sidecar saved on disk in the background. Real login is a
 *  later step (loginCookies / loginPassword) once the user provides
 *  credentials. */
export async function initGoBridge(options: GoBridgeOptions = {}): Promise<GoBridgeClient> {
  const sidecarPath = resolveSidecarPath(options);
  if (!fs.existsSync(sidecarPath)) {
    throw new Error(
      `Go sidecar binary not found at ${sidecarPath}. ` +
        `Set GO_SIDECAR_PATH to the sidecar binary (Lightsail: /home/admin/messenger-sidecar/messenger-sidecar).`
    );
  }
  const client = new GoBridgeClientImpl(sidecarPath, options);
  await client.start();
  return client;
}
