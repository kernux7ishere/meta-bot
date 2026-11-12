import { CommandHandler } from "./types.js";
import { db } from "../db/index.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { truncate } from "../utils/text.js";
import { learnStyleFromMessages } from "../llm/style-learning.js";

/**
 * Personas: named answer styles.
 *
 * - `default` is virtual (no row) and means base behaviour: no learned
 *   style is injected into the prompt.
 * - `.persona save <name> [N] [@users | whitelist]` LEARNS the style from
 *   the last N messages (the old `.learn` command, now folded in here)
 *   and saves it as a named persona, then switches to it.
 * - `.persona add <rule>` / `.persona auto on/off` are the old
 *   `.learn add` / `.learn auto`, moved here.
 * - `.persona save` / `add` / auto-learn always write into the ACTIVE
 *   persona (the db layer syncs thread_style.content back to it), so a
 *   persona stays current while it is active.
 * - Switching loads a persona's content into thread_style.content, which
 *   is what the prompt builder injects — so the agent loop needs no changes.
 */

export const DEFAULT_PERSONA = "default";

/** Valid persona names: lowercase letters/digits/_/-, 1-32 chars, starts with a letter or digit. */
export function normalizePersonaName(raw: string): string | null {
  const name = raw.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name)) return null;
  return name;
}

function formatTime(ts: number | null | undefined): string {
  if (!ts) return "Chưa cập nhật";
  return new Date(ts).toLocaleString("vi-VN");
}

export const personaCommand: CommandHandler = async ({ client, event, args }) => {
  const { threadID, messageID, senderID } = event;
  const currentBotUserId = client.getCurrentUserID();
  const ownerId = config.ownerId || currentBotUserId;

  // Enforce owner only check
  if (senderID !== ownerId && senderID !== currentBotUserId) {
    return;
  }

  const sub = (args[0] || "list").toLowerCase();
  const style = await db.getThreadStyle(threadID);
  const active = style.active_persona || DEFAULT_PERSONA;

  // .persona list
  if (sub === "list") {
    const personas = await db.getPersonas(threadID);
    const lines: string[] = ["Persona của nhóm:"];
    lines.push(`${active === DEFAULT_PERSONA ? "▶" : "•"} default — hành vi mặc định (không dùng phong cách đã học)`);
    for (const p of personas) {
      const marker = p.name === active ? "▶" : "•";
      const sources = p.sources && p.sources.length > 0 ? ` (nguồn: ${p.sources.join(", ")})` : "";
      lines.push(`${marker} ${p.name} — cập nhật: ${formatTime(p.updated_at)}${sources}`);
    }
    if (personas.length === 0) {
      lines.push("\nChưa có persona nào. Dùng .persona save <tên> để học phong cách từ tin nhắn và lưu lại.");
    }
    lines.push("\nĐổi persona: .persona switch <tên> (hoặc .persona switch default)");
    await client.sendMessage(lines.join("\n"), threadID, messageID);
    return;
  }

  // .persona switch <name>
  if (sub === "switch") {
    const rawName = args.slice(1).join(" ") || "";
    if (!rawName) {
      await client.sendMessage("Cách dùng: .persona switch <tên> (hoặc .persona switch default)", threadID, messageID);
      return;
    }
    const name = normalizePersonaName(rawName);
    if (!name) {
      await client.sendMessage("Tên persona không hợp lệ. Chỉ dùng chữ thường, số, _ và -, tối đa 32 ký tự.", threadID, messageID);
      return;
    }
    if (name === DEFAULT_PERSONA) {
      await db.setThreadStyle(threadID, { content: "", active_persona: DEFAULT_PERSONA });
      await client.sendMessage("Đã chuyển về persona default — bot dùng hành vi mặc định, không áp phong cách đã học.", threadID, messageID);
      return;
    }
    const persona = await db.getPersona(threadID, name);
    if (!persona) {
      await client.sendMessage(`Không tìm thấy persona '${name}'. Xem danh sách bằng .persona list.`, threadID, messageID);
      return;
    }
    await db.setThreadStyle(threadID, {
      content: persona.content,
      sources: persona.sources,
      active_persona: name,
    });
    const preview = persona.content.trim() ? `\n\n${persona.content.trim()}` : "";
    await client.sendMessage(`Đã chuyển sang persona '${name}'.${preview}`, threadID, messageID);
    return;
  }

  // .persona save <name> [N] [@users | whitelist] — learn from messages and save as a persona.
  if (sub === "save") {
    const rawName = args[1] || "";
    if (!rawName) {
      await client.sendMessage("Cách dùng: .persona save <tên> [số tin] [@người dùng | whitelist]", threadID, messageID);
      return;
    }
    const name = normalizePersonaName(rawName);
    if (!name) {
      await client.sendMessage("Tên persona không hợp lệ. Chỉ dùng chữ thường, số, _ và -, tối đa 32 ký tự.", threadID, messageID);
      return;
    }
    if (name === DEFAULT_PERSONA) {
      await client.sendMessage("'default' là persona mặc định có sẵn, không cần lưu.", threadID, messageID);
      return;
    }

    // Parse optional N (number of messages) and contributing sources.
    let n = 50;
    let remaining = args.slice(2);
    if (remaining.length > 0 && !isNaN(parseInt(remaining[0], 10))) {
      n = parseInt(remaining[0], 10);
      remaining.shift();
    }
    n = Math.min(Math.max(5, n), 200);

    let contributingUsers: string[] = [ownerId];
    if (remaining.length > 0 && remaining[0].toLowerCase() === "whitelist") {
      const accessData = await db.getAccessList(threadID);
      for (const uid of accessData.whitelist) {
        contributingUsers.push(uid);
      }
    } else if (event.mentions && Object.keys(event.mentions).length > 0) {
      for (const uid of Object.keys(event.mentions)) {
        contributingUsers.push(uid);
      }
    } else if (remaining.length > 0) {
      for (const item of remaining) {
        const clean = item.replace(/^@/, "").trim();
        if (clean) contributingUsers.push(clean);
      }
    }
    contributingUsers = Array.from(new Set(contributingUsers));

    const stopTyping = await client.sendTypingIndicator(threadID);
    await client.sendMessage(
      ` Đang phân tích ${n} tin nhắn gần nhất từ ${contributingUsers.length} nguồn để học phong cách và lưu thành persona '${name}'...`,
      threadID,
      messageID
    );

    try {
      const result = await learnStyleFromMessages(threadID, ownerId, n, contributingUsers, client);
      await db.savePersona(threadID, name, result.style, result.sources);
      await db.setThreadStyle(threadID, {
        content: result.style,
        sources: result.sources,
        active_persona: name,
        owner_msgs_since_learn: 0,
      });

      stopTyping();
      await client.sendMessage(
        ` Đã học và lưu persona '${name}' thành công! Bot đang dùng persona này.\n\n${result.style}`,
        threadID,
        messageID
      );
    } catch (err: any) {
      stopTyping();
      logger.error({ err: err.message, threadID }, "Failed to learn style in .persona save");
      await client.sendMessage(` Không thể học phong cách: ${err.message}`, threadID, messageID);
    }
    return;
  }

  // .persona add <persona> <rule> — append a manual style rule to a NAMED
  // persona (the target is explicit: a rule is always someone's trait).
  if (sub === "add") {
    const rawName = args[1] || "";
    const manualRule = args.slice(2).join(" ").trim();
    if (!rawName || !manualRule) {
      await client.sendMessage("Cách dùng: .persona add <tên persona> <nội dung quy tắc>", threadID, messageID);
      return;
    }
    const name = normalizePersonaName(rawName);
    if (!name) {
      await client.sendMessage("Tên persona không hợp lệ. Chỉ dùng chữ thường, số, _ và -, tối đa 32 ký tự.", threadID, messageID);
      return;
    }

    const newEntry = `- ${manualRule}`;
    if (name === DEFAULT_PERSONA) {
      let combined = style.content.trim()
        ? `${style.content.trim()}\n${newEntry}`
        : newEntry;
      if (combined.length > config.styleMaxChars) {
        combined = truncate(combined, config.styleMaxChars);
      }
      await db.setThreadStyle(threadID, { content: combined });
      await client.sendMessage(` Đã thêm quy tắc vào persona 'default':\n${newEntry}`, threadID, messageID);
      return;
    }

    const persona = await db.getPersona(threadID, name);
    if (!persona) {
      await client.sendMessage(`Không tìm thấy persona '${name}'. Xem danh sách bằng .persona list.`, threadID, messageID);
      return;
    }
    let combined = persona.content.trim()
      ? `${persona.content.trim()}\n${newEntry}`
      : newEntry;
    if (combined.length > config.styleMaxChars) {
      combined = truncate(combined, config.styleMaxChars);
    }
    if (active === name) {
      // Active persona: update the thread style (db syncs it back to the row).
      await db.setThreadStyle(threadID, { content: combined });
    } else {
      await db.savePersona(threadID, name, combined, persona.sources);
    }
    await client.sendMessage(` Đã thêm quy tắc vào persona '${name}':\n${newEntry}`, threadID, messageID);
    return;
  }

  // .persona auto on / off — toggle automatic style learning.
  if (sub === "auto") {
    const mode = args[1]?.toLowerCase();
    if (mode === "on") {
      await db.setThreadStyle(threadID, { auto_learn: true });
      await client.sendMessage(" Đã BẬT tự động học phong cách (auto_learn) cho nhóm này.", threadID, messageID);
      return;
    }
    if (mode === "off") {
      await db.setThreadStyle(threadID, { auto_learn: false });
      await client.sendMessage(" Đã TẮT tự động học phong cách (auto_learn) cho nhóm này.", threadID, messageID);
      return;
    }
    await client.sendMessage("Cách dùng: .persona auto on hoặc .persona auto off", threadID, messageID);
    return;
  }

  // .persona delete <name>
  if (sub === "delete") {
    const rawName = args.slice(1).join(" ") || "";
    if (!rawName) {
      await client.sendMessage("Cách dùng: .persona delete <tên>", threadID, messageID);
      return;
    }
    const name = normalizePersonaName(rawName);
    if (!name || name === DEFAULT_PERSONA) {
      await client.sendMessage("Không thể xóa persona 'default'.", threadID, messageID);
      return;
    }
    const deleted = await db.deletePersona(threadID, name);
    if (!deleted) {
      await client.sendMessage(`Không tìm thấy persona '${name}'.`, threadID, messageID);
      return;
    }
    if (active === name) {
      await db.setThreadStyle(threadID, { content: "", active_persona: DEFAULT_PERSONA });
      await client.sendMessage(`Đã xóa persona '${name}'. Đang dùng persona default.`, threadID, messageID);
      return;
    }
    await client.sendMessage(`Đã xóa persona '${name}'.`, threadID, messageID);
    return;
  }

  // .persona show [name]
  if (sub === "show") {
    const rawName = args.slice(1).join(" ") || "";
    if (!rawName || normalizePersonaName(rawName) === active) {
      const statusText = style.auto_learn ? "BẬT" : "TẮT";
      const sourcesStr =
        style.sources && style.sources.length > 0 ? style.sources.join(", ") : "(Chỉ chủ tài khoản)";
      const updatedTime = style.updated_at
        ? new Date(style.updated_at).toLocaleString("vi-VN")
        : "Chưa cập nhật";
      const contentText = style.content.trim() ? style.content.trim() : "(Chưa có phong cách nào được lưu)";
      await client.sendMessage(
        `Persona đang dùng: ${active}\n• Auto-learn: ${statusText}\n• Nguồn học: ${sourcesStr}\n• Tin nhắn chủ acc từ lần học trước: ${style.owner_msgs_since_learn}\n• Lần cập nhật cuối: ${updatedTime}\n\nQuy tắc phong cách:\n${contentText}`,
        threadID,
        messageID
      );
      return;
    }
    const name = normalizePersonaName(rawName);
    if (!name) {
      await client.sendMessage("Tên persona không hợp lệ.", threadID, messageID);
      return;
    }
    if (name === DEFAULT_PERSONA) {
      await client.sendMessage("Persona 'default' là hành vi mặc định — không có quy tắc phong cách nào được áp thêm.", threadID, messageID);
      return;
    }
    const persona = await db.getPersona(threadID, name);
    if (!persona) {
      await client.sendMessage(`Không tìm thấy persona '${name}'.`, threadID, messageID);
      return;
    }
    const contentText = persona.content.trim() ? persona.content.trim() : "(Chưa có phong cách nào được lưu)";
    await client.sendMessage(`Persona '${name}' (cập nhật: ${formatTime(persona.updated_at)}):\n\n${contentText}`, threadID, messageID);
    return;
  }

  await client.sendMessage(
    "Cách dùng:\n• .persona list — xem các persona\n• .persona save <tên> [số tin] [@người dùng | whitelist] — học phong cách từ tin nhắn và lưu thành persona\n• .persona switch <tên> — đổi persona (hoặc .persona switch default)\n• .persona add <tên persona> <quy tắc> — thêm quy tắc thủ công vào persona chỉ định\n• .persona auto on/off — bật/tắt tự động học phong cách\n• .persona delete <tên> — xóa persona\n• .persona show [tên] — xem quy tắc của persona",
    threadID,
    messageID
  );
};
