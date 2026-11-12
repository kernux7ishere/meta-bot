-- D1 Database Schema for Messenger AI Userbot

CREATE TABLE IF NOT EXISTS threads (
  thread_id TEXT PRIMARY KEY,
  ai_enabled INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory (
  thread_id TEXT PRIMARY KEY,
  content TEXT NOT NULL DEFAULT '',   -- markdown, capped (default ~50000 chars)
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS thread_style (
  thread_id TEXT PRIMARY KEY,
  content TEXT NOT NULL DEFAULT '',
  auto_learn INTEGER NOT NULL DEFAULT 0,
  owner_msgs_since_learn INTEGER NOT NULL DEFAULT 0,
  access_mode TEXT NOT NULL DEFAULT 'off',
  sources TEXT NOT NULL DEFAULT '[]',
  active_persona TEXT NOT NULL DEFAULT 'default',
  updated_at INTEGER NOT NULL
);

-- Named answer-style personas learned via .learn (one row per persona per
-- thread). 'default' is virtual (no row) and means "base behaviour, no
-- learned style". thread_style.content always holds the ACTIVE persona's
-- content (or '' when active_persona = 'default').
CREATE TABLE IF NOT EXISTS personas (
  thread_id TEXT NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  sources TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, name)
);

CREATE TABLE IF NOT EXISTS access_global (
  user_id TEXT PRIMARY KEY,
  list_type TEXT NOT NULL DEFAULT 'black',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS access_list (
  thread_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  list_type TEXT NOT NULL,  -- 'white' | 'black'
  created_at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  sender_name TEXT,
  body TEXT,
  reply_to_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_thread_time ON messages(thread_id, created_at DESC);

CREATE TABLE IF NOT EXISTS bot_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bot_messages_thread ON bot_messages(thread_id, created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
