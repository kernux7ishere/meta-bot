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
  updated_at INTEGER NOT NULL
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
