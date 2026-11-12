// Minimal fake of the Go Messenger sidecar's JSON-lines protocol, for
// unit tests ONLY (tests/unit-test.ts, test 22). It is not the real sidecar:
// it never touches the network, it just answers the documented commands
// (ping/version/status/login_cookies/send/disconnect) and two test-only
// commands:
//   emit_message {thread_id, sender_id, message_id, text, is_e2ee, attachments:[{type,url,preview_url,name,mime,size}], sticker_id, sticker_url}
//     -> emits a `message` event to the client (tests the listen path)
//   emit_message_attachments {thread_id, sender_id, message_id, attachments:[...], sticker_id, sticker_url}
//     -> emits a `message_attachments` event (late rows for an already-emitted message)
//   crash -> exits with code 1 (tests the client's auto-restart)
//
// Usage: node tests/mock-sidecar.mjs
// Logs (if any) go to stderr; stdout is JSON only, like the real sidecar.
import readline from "node:readline";

let loggedIn = false;
let userId = 0;
let presenceActive = true;
let lastTyping = null;
let lastSend = null;

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let cmd;
  try {
    cmd = JSON.parse(trimmed);
  } catch {
    send({ event: "error", ok: false, error: "invalid JSON command" });
    return;
  }
  const id = cmd.id;
  switch (cmd.cmd) {
    case "ping":
      return send({ event: "pong", ok: true, id });
    case "version":
      return send({ event: "version", ok: true, version: "0.1.0-mock", go: "go-mock", id });
    case "status":
      return send({
        event: "status",
        ok: true,
        connected: loggedIn,
        logged_in: loggedIn,
        user_id: userId,
        e2ee_ready: false,
        presence_active: presenceActive,
        id,
      });
    case "presence":
      if (typeof cmd.active === "boolean") presenceActive = cmd.active;
      return send({ event: "presence", ok: true, active: presenceActive, id });
    case "typing":
      lastTyping = { thread_id: cmd.thread_id, is_typing: !!cmd.is_typing, is_group: !!cmd.is_group };
      return send({ event: "typing", ok: true, id });
    case "last_typing":
      return send({ event: "last_typing", ok: true, last_typing: lastTyping, id });
    case "last_send":
      return send({ event: "last_send", ok: true, last_send: lastSend, id });
    case "login_cookies": {
      if (!cmd.cookies || Object.keys(cmd.cookies).length === 0) {
        return send({ event: "error", ok: false, id, cmd: "login_cookies", error: "no cookies provided and none saved on disk" });
      }
      loggedIn = true;
      userId = Number(cmd.cookies.c_user) || 12345;
      send({ event: "login_cookies", ok: true, user_id: userId, id });
      send({ event: "logged_in", ok: true, user_id: userId });
      return;
    }
    case "send": {
      if (!loggedIn) {
        return send({ event: "error", ok: false, id, cmd: "send", error: "not logged in" });
      }
      if (!cmd.text) {
        return send({ event: "error", ok: false, id, cmd: "send", error: "send requires text" });
      }
      if (!cmd.thread_id) {
        return send({ event: "error", ok: false, id, cmd: "send", error: "send requires thread_id" });
      }
      lastSend = { thread_id: cmd.thread_id, text: cmd.text, is_e2ee: !!cmd.is_e2ee, reply_to: cmd.reply_to ?? null, reply_to_sender_id: cmd.reply_to_sender_id ?? null };
      return send({ event: "sent", ok: true, otid: Date.now(), thread_id: cmd.thread_id, is_e2ee: !!cmd.is_e2ee, id });
    }
    case "disconnect":
      return send({ event: "disconnected", ok: true, id });
    case "emit_disconnected":
      // Async socket-drop event (no id — it is not a command response).
      send({ event: "disconnected", error: "test disconnect" });
      return send({ event: "emit_disconnected", ok: true, id });
    case "emit_connected":
      send({ event: "connected" });
      return send({ event: "emit_connected", ok: true, id });
    case "emit_message":
      send({
        event: "message",
        thread_id: cmd.thread_id,
        sender_id: cmd.sender_id,
        message_id: cmd.message_id,
        text: cmd.text,
        is_e2ee: !!cmd.is_e2ee,
        timestamp_ms: Date.now(),
        is_own: false,
        ...(cmd.attachments ? { attachments: cmd.attachments } : {}),
        ...(cmd.sticker_id ? { sticker_id: cmd.sticker_id } : {}),
        ...(cmd.sticker_url ? { sticker_url: cmd.sticker_url } : {}),
      });
      return send({ event: "emit_message", ok: true, id });
    case "emit_message_attachments":
      send({
        event: "message_attachments",
        thread_id: cmd.thread_id,
        sender_id: cmd.sender_id ?? 0,
        message_id: cmd.message_id,
        ...(cmd.attachments ? { attachments: cmd.attachments } : {}),
        ...(cmd.sticker_id ? { sticker_id: cmd.sticker_id } : {}),
        ...(cmd.sticker_url ? { sticker_url: cmd.sticker_url } : {}),
      });
      return send({ event: "emit_message_attachments", ok: true, id });
    case "crash":
      process.exit(1);
    default:
      return send({ event: "error", ok: false, id, cmd: cmd.cmd, error: `unknown cmd "${cmd.cmd}"` });
  }
});
