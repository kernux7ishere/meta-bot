import { CommandHandler } from "./types.js";

export const helpCommand: CommandHandler = async ({ client, event }) => {
  const helpText = ` Danh sách lệnh AI Userbot (chỉ chủ tài khoản):
• .ai on — Bật AI auto-reply cho nhóm này
• .ai off — Tắt AI auto-reply cho nhóm này
• .ai <câu hỏi> — Hỏi AI trực tiếp (luôn hoạt động)
• .learn [n] [@users | whitelist] — Học phong cách từ tin nhắn của chủ acc + người được chỉ định hoặc whitelist
• .learn show — Xem phong cách đã học, nguồn học và trạng thái auto-learn
• .learn reset — Xóa phong cách đã học của nhóm
• .learn add <quy tắc> — Thêm quy tắc phong cách thủ công
• .learn auto on/off — Bật/tắt tự động học phong cách
• .list mode off|whitelist|blacklist — Đặt chế độ kiểm soát truy cập cho nhóm hiện tại
• .list add @user / remove @user — Thêm/xóa người dùng vào danh sách kiểm soát của nhóm
• .list show — Hiển thị danh sách whitelist & blacklist của nhóm và global blacklist
• .list global ban @user / unban @user — Cấm/gỡ cấm người dùng trên toàn bộ các nhóm
• .self set / show — Đặt hoặc xem thread cá nhân (SELF_THREAD_ID)
• .summary [n] — Tóm tắt tin nhắn gửi về SELF_THREAD_ID (mặc định)
• .summary [n] here — Tóm tắt tin nhắn và gửi trực tiếp vào nhóm hiện tại
• .memory — Xem bộ nhớ ngữ cảnh hiện tại của nhóm
• .forget confirm — Xóa toàn bộ ghi nhớ của nhóm
• .help — Hiện danh sách hướng dẫn này`;

  await client.sendMessage(helpText, event.threadID, event.messageID);
};
