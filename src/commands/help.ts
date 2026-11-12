import { CommandHandler } from "./types.js";

export const helpCommand: CommandHandler = async ({ client, event }) => {
  const helpText = `Lệnh AI Userbot (chỉ chủ tài khoản):

.ai
• on : Bật auto-reply cho nhóm này
• off : Tắt auto-reply cho nhóm này
• <câu hỏi> : Hỏi AI trực tiếp

.persona: save <tên> [n] [@users|whitelist] | list | switch <tên> | show [tên] | add <tên> <quy tắc> | auto on|off | delete <tên>
  Học phong cách, lưu/đổi/xem/thêm/xóa persona.

.list
• mode off|whitelist|blacklist : Đặt chế độ kiểm soát truy cập cho nhóm
• add @user : Thêm người vào danh sách của chế độ hiện tại
• remove @user : Xóa người khỏi danh sách của nhóm
• show : Xem chế độ, whitelist, blacklist và global blacklist
• global ban @user : Cấm người dùng trên toàn bộ các nhóm
• global unban @user : Gỡ cấm người dùng

.self
• set : Đặt thread cá nhân (SELF_THREAD_ID)
• show : Xem thread cá nhân

.react
• on : Bật tự thả biểu cảm
• off : Tắt tự thả biểu cảm

.typing
• user : Giả lập người dùng — hiện typing indicator, thời gian theo độ dài câu trả lời
• bot : Trả lời nhanh, không hiện typing indicator
• (không ghi gì) : Xem chế độ typing hiện tại

.presence
• on : Tự động — hiện "Đang hoạt động" khi có hoạt động, tự tắt sau 10 phút im lặng
• off : Không hiện trạng thái hoạt động
• (không ghi gì) : Xem trạng thái hiện tại

.model
• (không ghi gì) : Xem model hiện tại
• list [từ khóa] : Tìm model theo tên chung, gom theo provider (vd: list gemini)
• <tên model> : Đổi sang model đó
• reset : Về lại model mặc định (LLM_MODEL)

.summary
• [n] : Tóm tắt tin nhắn gửi về chat riêng
• [n] here : Tóm tắt tin nhắn gửi trực tiếp vào nhóm

.memory : Xem bộ nhớ ngữ cảnh của nhóm.
.forget confirm : Xóa toàn bộ ghi nhớ của nhóm.
.help : Hiện danh sách này.`;

  await client.sendMessage(helpText, event.threadID, event.messageID);
};
