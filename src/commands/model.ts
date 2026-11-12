import { CommandHandler } from "./types.js";
import { config } from "../config.js";
import {
  getCurrentModel,
  getModelDefault,
  setCurrentModel,
  resetModel,
  listModels,
  fetchAllModelIds,
  modelProvider,
} from "../llm/model.js";

/**
 * .model — switch the LLM model at runtime (global, all threads).
 * Owner only. The choice persists in bot.db so it survives
 * restarts; `.model reset` goes back to the LLM_MODEL env default.
 *
 * - .model            : show the current model
 * - .model list [q]   : list available models (filter by substring q)
 * - .model <name>     : switch to that model
 * - .model reset      : back to the env default
 */
export const modelCommand: CommandHandler = async ({ client, event, args }) => {
  const { threadID, messageID, senderID } = event;
  const currentBotUserId = client.getCurrentUserID();
  const ownerId = config.ownerId || currentBotUserId;

  if (senderID !== ownerId && senderID !== currentBotUserId) {
    return; // owner only
  }

  const usage =
    "Cách dùng lệnh .model:\n" +
    "• .model : Xem model hiện tại\n" +
    "• .model list [từ khóa] : Tìm model theo tên chung, gom theo provider (vd: .model list gemini)\n" +
    "• .model <tên model> : Đổi sang model đó\n" +
    "• .model reset : Về lại model mặc định (LLM_MODEL)";

  const sub = args[0];

  // No args: show current model.
  if (!sub) {
    const current = getCurrentModel();
    const def = getModelDefault();
    const extra = current === def ? "" : `\nMặc định (LLM_MODEL): ${def}`;
    await client.sendMessage(`Model hiện tại: ${current}${extra}`, threadID, messageID);
    return;
  }

  if (sub.toLowerCase() === "reset") {
    const next = resetModel();
    await client.sendMessage(`Đã về lại model mặc định: ${next}`, threadID, messageID);
    return;
  }

  if (sub.toLowerCase() === "list") {
    const query = args.slice(1).join(" ").trim() || undefined;
    try {
      const { models, total } = await listModels(query);
      if (models.length === 0) {
        await client.sendMessage(
          query ? `Không tìm thấy model nào chứa "${query}".` : "Không có model nào.",
          threadID,
          messageID
        );
        return;
      }
      const current = getCurrentModel();
      // Group by provider so `.model list gemini` reads as "which providers
      // have a gemini model", not one flat list of ids.
      const groups = new Map<string, string[]>();
      for (const m of models) {
        const p = modelProvider(m.id);
        if (!groups.has(p)) groups.set(p, []);
        groups.get(p)!.push(m.id === current ? `▶ ${m.id}` : `• ${m.id}`);
      }
      const sections = [...groups.entries()].map(
        ([p, lines]) => `${p}:\n${lines.join("\n")}`
      );
      const truncated = total > models.length ? `\n\n(Hiện ${models.length}/${total} kết quả — thêm từ khóa để lọc hẹp hơn.)` : "";
      await client.sendMessage(
        `Model hiện tại: ${current}\n\n${sections.join("\n\n")}${truncated}\n\nĐổi bằng: .model <tên model>`,
        threadID,
        messageID
      );
    } catch (err: any) {
      await client.sendMessage(`Lỗi lấy danh sách model: ${err.message}`, threadID, messageID);
    }
    return;
  }

  // Switch to the named model. Verify it exists against the FULL provider
  // list (uncapped — the display list is capped at 30, so validating
  // against it would reject most real models).
  const name = args.join(" ").trim();
  try {
    const ids = new Set(await fetchAllModelIds());
    if (ids.size > 0 && !ids.has(name)) {
      await client.sendMessage(
        `Không tìm thấy model "${name}". Xem danh sách bằng .model list [từ khóa].`,
        threadID,
        messageID
      );
      return;
    }
  } catch {
    // List unreachable — accept the name; the LLM call will validate it.
  }
  const next = setCurrentModel(name);
  await client.sendMessage(`Đã đổi model sang: ${next}`, threadID, messageID);
};
