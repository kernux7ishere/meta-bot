import { AgentTool } from "./types.js";
import { logger } from "../utils/logger.js";
import { namesFromHistory } from "./list-members.js";
import {
  scheduleReminder,
  MAX_REMINDER_DELAY_MS,
  MIN_REMINDER_DELAY_MS,
} from "../scheduler/reminders.js";

function formatDelay(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} giây`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds > 0 ? `${minutes} phút ${seconds} giây` : `${minutes} phút`;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes > 0 ? `${hours} giờ ${restMinutes} phút` : `${hours} giờ`;
}

/** User's timezone for absolute times ("ping tôi lúc 12:51"). */
const USER_TIMEZONE = "Asia/Ho_Chi_Minh";

/** Offset of the user's timezone from UTC, in ms (computed live, no DST
 *  assumption — Vietnam is fixed UTC+7 but this stays correct anywhere). */
function getTimezoneOffsetMs(now: Date): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: USER_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(now)) parts[p.type] = p.value;
  const asUTC = Date.UTC(
    +parts.year,
    +parts.month - 1,
    +parts.day,
    +parts.hour % 24,
    +parts.minute,
    +parts.second
  );
  return asUTC - now.getTime();
}

/**
 * Delay (ms) from now until the next occurrence of a wall-clock time
 * "HH:MM" (or "HHhMM", "HH:MM:SS") in the user's timezone. Today if it is
 * still ahead, otherwise tomorrow. Returns null when the string does not
 * parse as a time.
 */
function delayUntilTime(at: string): number | null {
  const m = at.trim().match(/^(\d{1,2})[:h](\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const ss = m[3] ? Number(m[3]) : 0;
  if (hh > 23 || mm > 59 || ss > 59) return null;
  const now = new Date();
  const offsetMs = getTimezoneOffsetMs(now);
  // Epoch ms of the user's wall clock (its UTC fields ARE the local time).
  const localNow = Date.now() + offsetMs;
  const d = new Date(localNow);
  let target = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    hh,
    mm,
    ss
  );
  let delayMs = target - localNow;
  if (delayMs < MIN_REMINDER_DELAY_MS) {
    // Already passed (or too soon) — next occurrence is tomorrow.
    target += 24 * 3600 * 1000;
    delayMs = target - localNow;
  }
  return delayMs;
}

export const remindTool: AgentTool = {
  definition: {
    type: "function",
    function: {
      name: "remind",
      description:
        "Schedule a message to be sent to this chat later — a reminder or a timed ping. Use it whenever the user asks to be reminded / pinged later, in EITHER form: a relative delay ('2 phút nữa ping tôi', 'nhắc tôi sau 1 giờ', 'hẹn 5 phút nữa nhắc ...', 'tuần sau ping tôi' → delay_seconds, up to 14 days) OR an absolute time ('ping tôi lúc 12:51', 'nhắc tôi khi 12:51', 'ping tôi vào 9 giờ sáng' → at='12:51'). The bot CAN schedule and count minutes itself; it does NOT need the user to call it again. Never answer that scheduling is unavailable — always call this tool. A pending reminder does NOT block the bot: other messages are still received and answered normally while a timer waits in the background. To @mention (ping) the person who asked, set mention_sender=true. To @mention other members, pass their user IDs in mentions (get them from list_members first) and include each display name in text.",
      parameters: {
        type: "object",
        properties: {
          delay_seconds: {
            type: "number",
            description: "Seconds from now until the message is sent (10s minimum, 14 days maximum). Convert the user's words: '2 phút' = 120, '1 giờ' = 3600, 'tuần sau' (7 days) = 604800, '2 tuần' = 1209600. Use this OR 'at', not both.",
          },
          at: {
            type: "string",
            description: "Absolute wall-clock time to send the message, 'HH:MM' (24h, user's local time, e.g. '12:51'). Use this when the user names a clock time ('lúc 12:51', 'khi 12:51', 'vào 9 giờ'). If that time today already passed, it fires tomorrow. Use this OR 'delay_seconds', not both.",
          },
          text: {
            type: "string",
            description: "The message to send when the timer fires. Include each mentioned person's display name (e.g. '@Phong') in the text. If mention_sender is true, the sender's @mention is prepended automatically.",
          },
          mentions: {
            type: "array",
            items: { type: "string" },
            description: "User IDs to @mention (ping) when the reminder fires. Each mentioned person's display name must appear in text.",
          },
          mention_sender: {
            type: "boolean",
            description: "Set true when the user asks to be pinged/reminded themselves ('ping tôi', 'nhắc tôi'). The sender is @mentioned in the fired message.",
          },
        },
        required: ["text"],
      },
    },
  },

  async execute(
    args: {
      delay_seconds?: number;
      at?: string;
      text: string;
      mentions?: string[];
      mention_sender?: boolean;
    },
    context
  ): Promise<string> {
    const client = context.client;
    if (!client) {
      return "Error: cannot schedule reminders — no live Messenger client in this run.";
    }
    // Resolve the delay: absolute clock time wins, else a relative delay.
    let delayMs: number;
    let whenLabel: string;
    if (typeof args.at === "string" && args.at.trim()) {
      const parsed = delayUntilTime(args.at);
      if (parsed === null) {
        return "Error: giờ hẹn không đúng định dạng — dùng 'HH:MM' (ví dụ '12:51').";
      }
      delayMs = parsed;
      whenLabel = `lúc ${args.at.trim()}`;
    } else if (args.delay_seconds !== undefined && args.delay_seconds !== null) {
      const delaySeconds = Number(args.delay_seconds);
      if (!Number.isFinite(delaySeconds) || delaySeconds <= 0) {
        return "Error: delay_seconds phải là số giây > 0.";
      }
      delayMs = Math.round(delaySeconds * 1000);
      whenLabel = `sau ${formatDelay(delayMs)}`;
    } else {
      return "Error: cần delay_seconds hoặc at (giờ 'HH:MM').";
    }
    if (delayMs < MIN_REMINDER_DELAY_MS) {
      return `Error: hẹn tối thiểu ${formatDelay(MIN_REMINDER_DELAY_MS)}. Muốn gửi ngay thì gửi tin nhắn thường thay vì hẹn.`;
    }
    if (delayMs > MAX_REMINDER_DELAY_MS) {
      return `Error: hẹn tối đa ${formatDelay(MAX_REMINDER_DELAY_MS)}.`;
    }
    let text = (args.text || "").trim();
    if (!text) {
      return "Error: text is empty.";
    }
    // Resolve display names for the mentions (sidecar roster, then history).
    // Never mention the bot itself.
    const botId = client.getCurrentUserID?.() || "";
    const mentionIds = (args.mentions || []).map(String).filter((id) => id && id !== "0" && id !== botId);
    if (args.mention_sender && context.senderId && context.senderId !== botId) {
      if (!mentionIds.includes(context.senderId)) {
        mentionIds.push(context.senderId);
      }
    }
    let roster: Array<{ userID: string; name?: string }> = [];
    try {
      if (typeof (client as any).getThreadMembers === "function") {
        roster = await (client as any).getThreadMembers(context.threadId);
      }
    } catch {
      // fall back to history names only
    }
    const historyNames = await namesFromHistory(context.threadId, botId);
    const mentionRefs = mentionIds
      .map((id) => {
        const fromRoster = roster.find((m) => m.userID === id);
        const name = fromRoster?.name || historyNames.get(id) || "";
        return { user_id: id, name };
      })
      .filter((m) => m.name);
    // Deduplicate by display name (same reason as send_message): mentioning
    // one name twice kills Facebook's "mentioned you" notification. Prefer
    // the sender when they are among the duplicates.
    const byName = new Map<string, { user_id: string; name: string }>();
    for (const m of mentionRefs) {
      const existing = byName.get(m.name);
      if (!existing) {
        byName.set(m.name, m);
      } else if (m.user_id === context.senderId && existing.user_id !== context.senderId) {
        byName.set(m.name, m);
      }
    }
    const deduped = [...byName.values()];
    // Make sure every mentioned name actually appears in the text as "@Name",
    // otherwise the @mention has nothing to anchor to. Collapse a duplicated
    // "@Name" in the text so it matches the deduped mentions.
    for (const m of deduped) {
      if (!text.includes(`@${m.name}`) && !text.includes(m.name)) {
        text = `@${m.name} ${text}`;
      } else {
        const tag = `@${m.name}`;
        const first = text.indexOf(tag);
        const second = first >= 0 ? text.indexOf(tag, first + tag.length) : -1;
        if (second >= 0) {
          text = text.slice(0, second) + text.slice(second + tag.length).replace(/^\s+/, " ");
          text = text.replace(/\s{2,}/g, " ").trim();
        }
      }
    }
    const fireAt = Date.now() + delayMs;
    const reminder = scheduleReminder(client, {
      threadId: context.threadId,
      fireAt,
      text,
      mentions: deduped,
      requesterId: context.senderId,
    });
    logger.info(
      { reminderId: reminder.id, threadId: context.threadId, delayMs, mentions: deduped.map((m) => m.user_id) },
      "Reminder scheduled"
    );
    const who = deduped.length > 0 ? ` (ping ${deduped.map((m) => m.name).join(", ")})` : "";
    return `Đã hẹn: ${whenLabel} (sau ${formatDelay(delayMs)}) sẽ gửi "${text}"${who}.`;
  },
};
