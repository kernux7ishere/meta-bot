# Local SQLite store (since 2026-11-11)

The bot's data lives in ONE local SQLite file, `bot.db`, in the bot
dir on Lightsail. This replaced the old split: D1 (via the Cloudflare
gateway Worker) for the "real" data plus a pile of local JSON files
(`typing-modes.json`, `presence.json`, `llm-model.json`,
`reminders.json`, `sticker-pack.json`, `sent-images.json`,
`recent-attachments.json`, `recent-message-links.json`,
`sticker-vec.json`) for everything added while the worker deploy was
blocked. The JSON files are gone; their contents moved into tables in
the same file. No bot behaviour, command, prompt or LLM path changed —
only the storage layer moved.

## Backend choice

`DB_BACKEND` (env, default `sqlite`):

| Value | Meaning |
| --- | --- |
| `sqlite` (default) | Local `bot.db` (`SQLITE_PATH`, default `./bot.db`). The store. |
| `gateway` | Cloudflare D1 via the Worker gateway. **Rollback only** — needs `GATEWAY_URL` + `GATEWAY_TOKEN`. Typing mode + presence still come from the local SQLite file in this mode (they never lived in D1). |
| `memory` | In-memory only; nothing persists. Tests/dev. |

If SQLite cannot be opened, the bot **throws at startup and refuses
to start** — it never silently falls back to in-memory (that would
look like working while losing data). To roll back, set
`DB_BACKEND=gateway` and restart; D1 was never modified by the
migration, so it still holds the pre-migration data.

## Schema overview (`src/db/sqlite-conn.ts`, version 1)

WAL mode (`PRAGMA journal_mode = WAL`), `meta` table with
`schema_version`. Tables mirror the D1 schema in
`worker/src/index.ts`, plus one table per former JSON file:

- Core: `threads` (ai_enabled), `memory`, `thread_style` (content,
  auto_learn, owner_msgs_since_learn, access_mode, sources JSON,
  active_persona), `personas` (PK thread_id+name), `access_list`,
  `access_global`, `messages` (indexed on thread_id+created_at),
  `bot_messages`, `settings` (key/value: `self_thread_id`,
  `presence_enabled`, `llm_model`).
- Former JSON files: `typing_modes`, `sticker_pack` (builtins seeded
  on init, source=`builtin`), `sent_images` (unique per
  thread+normalized URL, cap 200/thread), `recent_attachments` +
  `message_links` (caps 20 / 200 per thread), `sticker_vec`
  (embedding as JSON text, cap 200/thread), `reminders`.

All access goes through one shared `DatabaseSync` connection
(`src/db/sqlite-conn.ts`: `getConnection()`), used by
`SqliteDatabaseClient` (`src/db/sqlite.ts`, implements the existing
`DatabaseService` interface) and by the former JSON store modules
(`src/sticker-pack.ts`, `src/sent-images.ts`,
`src/recent-attachments.ts`, `src/sticker-vec.ts`,
`src/scheduler/reminders.ts`, `src/llm/model.ts` — all keep their
exported function names/signatures). `node:sqlite` is imported only in
`sqlite-conn.ts`, `sqlite.ts`, and the migration script. `model.ts`
still must NOT import logger or config (circular-import hazard) —
`sqlite-conn.ts` is dependency-free, so it is safe to import there.

## Running the migration (`scripts/migrate-to-sqlite.ts`)

Run it ONCE, on Lightsail, with the bot **stopped**. Sources are
read-only (D1 and the JSON files are never modified); writes upsert by
primary key, so re-running is safe.

```bash
# 1. Stop the bot (frees the sidecar + avoids writes mid-migration).
systemctl --user stop messenger-userbot.service

# 2. Dry-run first: counts only, writes nothing.
cd ~/messenger-userbot
GATEWAY_URL=https://messenger-userbot-gateway.earthly-gab-serve.workers.dev \
GATEWAY_TOKEN=$(cat ~/.gateway-token-new) \
npx tsx scripts/migrate-to-sqlite.ts \
  --threads 8835038716594816 \
  --db ./bot.db --dry-run

# 3. Real run (same command without --dry-run). Prints a per-source
#    count summary, then re-reads every table from bot.db to verify.
GATEWAY_URL=https://messenger-userbot-gateway.earthly-gab-serve.workers.dev \
GATEWAY_TOKEN=$(cat ~/.gateway-token-new) \
npx tsx scripts/migrate-to-sqlite.ts \
  --threads 8835038716594816 \
  --db ./bot.db

# 4. Start the bot (default DB_BACKEND=sqlite picks up bot.db).
systemctl --user start messenger-userbot.service
```

Flags: `--threads id1,id2,...` (required for the D1 part),
`--db <path>` (default `./bot.db`), `--json-dir <dir>` (default: the
bot dir), `--dry-run`, `--skip-gateway` (JSON only),
`--skip-json` (D1 only).

### Finding thread ids

The gateway has no "list all threads" endpoint, so thread ids must be
supplied. Known ones:

- Test group: `8835038716594816`.
- The owner's self-chat id is fetched from the gateway automatically
  (`GET /self-thread`) and added to the list.
- Any other thread: grep the bot journal for `threadID`
  (`journalctl --user -u messenger-userbot.service | grep -o
  'threadID[^,]*'`), or take ids from a D1 dump.

A thread left out keeps its D1 data (nothing is deleted) and can be
migrated later by re-running with `--threads` extended.

### Known gaps

- `GET /messages/:threadId` caps at 200 rows and has no paging, so at
  most the latest 200 saved messages per thread migrate. The bot only
  ever reads recent history anyway.
- Bot-message ids (`bot_messages`) cannot migrate: the gateway has no
  list endpoint for them, only a check-by-id. They are a dedup cache
  for the bot's own echoes; the bot re-records its own sends going
  forward, and the router also ignores echoes by sender id, so losing
  the old ids is harmless.
- A JSON file that never existed (e.g. `presence.json` when `.presence
  off` was never used) migrates as empty, which is the same as its
  default.

## Deploy-tar rule

**`bot.db` (and its WAL sidecars `bot.db-wal`, `bot.db-shm`) must be
EXCLUDED from deploy tars** — same rule as the old JSON files. The
live file stays on the box; a deploy that overwrote it would wipe all
bot data. The tar exclusion list now covers `bot.db*`. (`.gitignore`
also excludes them.)

## Backup (separate step)

Backup is NOT part of the migration: the file is backed up to
Cloudflare R2 via rclone (nightly cron, consistent snapshot with
SQLite's `.backup` — never a raw `cp` of the live file while the bot
runs, because WAL mode means the file alone can be inconsistent).
See the R2 backup setup (separate task).
