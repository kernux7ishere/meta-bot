# Luminous

Facebook Messenger **userbot** tự host: một trợ lý AI chạy trực tiếp trên tài khoản Messenger (khuyên dùng tài khoản phụ), trả lời trong nhóm chat và DM. Kiến trúc dạng **agent** (lấy cảm hứng từ Hermes Agent của Nous Research): bộ nhớ dài hạn, function calling, tương thích mọi LLM chuẩn OpenAI API.

- **Bot Node.js** (repo này): router, lệnh, agent LLM + công cụ, memory, guards.
- **Go sidecar** ([mautrix/meta](https://github.com/mautrix/meta)): lo protocol Messenger + E2EE (Armadillo) — thứ Node không làm được. Bot spawn nó, giao tiếp qua JSON stdin/stdout. `MESSENGER_CLIENT=fca` giữ lại làm fallback.
- **Lưu trữ: SQLite local (`bot.db`)** là mặc định; backup mã hóa lên R2 mỗi đêm. Cloudflare D1 Worker (`worker/`) chỉ còn là đường rollback (`DB_BACKEND=gateway`).
- **LLM** qua endpoint OpenAI-compatible (mặc định OmniRoute `http://127.0.0.1:20128/v1`).

Mặc định trả lời bằng ngôn ngữ của tin nhắn gửi đến (chủ yếu là **Tiếng Việt** tự nhiên).

---

## Tính năng

- **Auto-reply:** khi AI bật trong thread, chỉ trả lời khi có người reply tin nhắn của bot hoặc @mention bot. `.ai <câu hỏi>` luôn chạy, kể cả khi AI đang tắt.
- **E2EE DM:** đọc và trả lời DM mã hóa đầu cuối, **quote-reply được cả hai chiều** (đi và về).
- **Hiểu media:** ảnh / sticker / file đính kèm — kể cả file gửi từ tin nhắn trước và reply-chain nhiều tầng. Bot nhớ cả ảnh chính nó đã gửi.
- **Sticker:** pack theo cảm xúc, học thụ động từ sticker của owner, tìm theo ngữ nghĩa (embedding).
- **Persona (`.persona`):** lưu / đổi / học phong cách trả lời theo từng thread, auto-learn tùy chọn.
- **Model runtime (`.model`):** đổi model đang chạy không cần restart; `.model list <từ khóa>` tìm trong toàn bộ catalog.
- **Nhắc hẹn:** `remind` — hẹn theo giây hoặc giờ tuyệt đối (`HH:MM`, giờ VN), tối đa 14 ngày, tự thử lại khi gửi lỗi.
- **Chống lặp fact:** mọi fact bot đã đưa đều được ghi lại và đưa vào ngữ cảnh — không đưa lại, kể cả diễn đạt khác.
- **Chống checkpoint:** tin gửi cách nhau ≥1.5s + jitter, delay "đọc" 0.8–2.5s trước khi trả lời; typing indicator; presence "Đang hoạt động" tự động theo idle 10 phút.
- **An toàn ở code** (`src/llm/guards.ts`): chặn secret, SSRF, prompt injection trong mọi tool call; quét câu trả lời trước khi gửi. Secret không bao giờ đi qua chat hay file.

---

## Cài đặt

Yêu cầu: Node 24+, Go 1.26+ (cho sidecar).

```bash
git clone https://github.com/kernux7ishere/meta-bot luminous
cd luminous
npm install
cp .env.example .env   # điền OWNER_ID, LLM_BASE_URL, LLM_API_KEY, LLM_MODEL
```

**Go sidecar** (mã nguồn ở `cmd/messenger-sidecar` trong cây [mautrix/meta](https://github.com/mautrix/meta) — repo riêng, không nằm trong repo này):

```bash
cd ~/mautrix-meta
go build -o ~/messenger-sidecar/messenger-sidecar ./cmd/messenger-sidecar/
```

Trỏ `GO_SIDECAR_PATH` trong `.env` tới binary đó, đặt `MESSENGER_CLIENT=go`.

**Đăng nhập:** chạy bot lần đầu, đăng nhập bằng username/password qua sidecar (2FA TOTP) — session lưu trong state dir của sidecar, tự dùng lại lần sau. `appstate.json` chỉ là đường fallback khi dùng `MESSENGER_CLIENT=fca`.

```bash
npm run build
npm test        # bộ test đơn vị (§1–§31)
npm start       # chạy nền: systemd user service, xem src/index.ts
```

---

## Lệnh (chỉ owner, prefix `.`)

| Lệnh | Mô tả |
|---|---|
| `.ai on` / `.ai off` | Bật / tắt auto-reply trong thread hiện tại. |
| `.ai <câu hỏi>` | Hỏi trực tiếp, chạy cả khi AI đang tắt. |
| `.help` | Liệt kê lệnh. |
| `.memory` | Xem bộ nhớ đã lưu của thread. |
| `.forget` | Xóa bộ nhớ của thread. |
| `.summary [n]` / `[n] here` | Tóm tắt n tin gần nhất (mặc định gửi về self-chat, `here` gửi tại chỗ). |
| `.persona save <tên> [n]` / `list` / `switch <tên>` / `show [tên]` / `add <tên> <quy tắc>` / `auto on\|off` / `delete <tên>` | Quản lý phong cách trả lời theo thread. |
| `.list mode off\|whitelist\|blacklist` / `add` / `remove` / `show` / `global ban\|unban @user` | Kiểm soát ai được kích hoạt bot. |
| `.self set` / `show` | Đặt / xem self-chat (nơi nhận tóm tắt + thông báo nền). |
| `.react on` / `off` | Bật / tắt reaction theo ngữ cảnh. |
| `.typing user` / `bot` | Hiện typing indicator trong lúc suy nghĩ, hoặc trả lời nhanh. |
| `.presence on` / `off` | Bật / tắt "Đang hoạt động" (tự động theo idle 10 phút). |
| `.model` / `list [từ khóa]` / `<tên model>` / `reset` | Xem / tìm / đổi model runtime. |
| `.sticker` / `tag <id> <tên> [cảm xúc]` | Xem pack sticker, gắn tên/cảm xúc. |

## Công cụ của agent (13)

`search_web`, `read_url`, `read_image`, `read_file`, `remember`, `record_fact`, `send_image`, `send_file`, `send_sticker`, `send_message`, `list_members`, `remind`, `reverse_image_search`. Tối đa `MAX_TOOL_CALLS` (mặc định 3) lượt gọi mỗi lượt trả lời.

---

## Cấu trúc

```
├─ src/
│  ├─ index.ts              # Khởi động bot, retention purge (12h), khôi phục reminder
│  ├─ router.ts             # Định tuyến: quyền, trigger (reply/@mention), gửi trả lời
│  ├─ agent-context.ts      # Ngữ cảnh chung cho .ai và auto-reply (media, fact đã đưa…)
│  ├─ given-facts.ts        # Fact đã đưa (chống lặp) — bảng given_facts
│  ├─ sent-images.ts / recent-attachments.ts / sticker-pack.ts / sticker-vec.ts
│  ├─ scheduler/reminders.ts
│  ├─ commands/             # .ai .help .memory .forget .summary .persona .list .self
│  │                       # .react .typing .presence .model .sticker
│  ├─ llm/                  # client, agent loop, guards, model runtime, embeddings
│  ├─ messenger/            # Go bridge client, typing, pacing, reactions, types
│  ├─ tools/                # 13 công cụ của agent
│  ├─ prompt/assembler.ts   # Ghép system prompt (soul + user + style + memory)
│  ├─ db/                   # SQLite client (mặc định) / D1 gateway (rollback) / memory
│  └─ config.ts             # Biến môi trường tập trung
├─ worker/                  # Cloudflare Worker D1 gateway (rollback only)
├─ tests/                   # unit-test.ts (§1–§31) + mock-sidecar.mjs
├─ scripts/migrate-to-sqlite.ts
├─ soul.md / user.md        # Giọng điệu + giới hạn hành vi của bot
├─ .env.example
└─ README.md
```

Chi tiết vận hành (checkpoint, proxy, migration SQLite): xem `docs/`.

---

## Lưu ý

- **Điều khoản Facebook:** userbot có thể vi phạm ToS. Dùng tài khoản phụ, giữ tần suất tự nhiên, một session một IP, không đăng nhập tài khoản bot trên máy khác trong lúc bot chạy. Sau khi đăng nhập lại, giữ hoạt động nhẹ 24–48h (warm-up).
- **Bảo mật:** không bao giờ paste password, API key, appstate hay mã OTP vào chat. `.env`, `appstate.json`, `bot.db`, `.gateway-token-new` đã nằm trong `.gitignore`.
