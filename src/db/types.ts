export interface MessageRecord {
  id: string;
  thread_id: string;
  sender_id: string;
  sender_name?: string | null;
  body?: string | null;
  reply_to_id?: string | null;
  created_at: number;
}

export interface ThreadSettings {
  thread_id: string;
  ai_enabled: boolean;
  updated_at?: number | null;
}

export interface ThreadMemory {
  thread_id: string;
  content: string;
  updated_at?: number | null;
}

export interface ThreadStyle {
  thread_id: string;
  content: string;
  auto_learn: boolean;
  owner_msgs_since_learn: number;
  access_mode: "off" | "whitelist" | "blacklist";
  sources: string[];
  /** Name of the active persona for this thread. 'default' = base behaviour (no learned style). */
  active_persona: string;
  updated_at?: number | null;
}

/** A named answer-style persona, learned via .persona save. */
export interface Persona {
  thread_id: string;
  name: string;
  content: string;
  sources: string[];
  created_at: number;
  updated_at: number;
}

export interface AccessListData {
  thread_id: string;
  access_mode: "off" | "whitelist" | "blacklist";
  whitelist: string[];
  blacklist: string[];
  global_blacklist: string[];
}

export interface DatabaseService {
  getThreadSettings(threadId: string): Promise<ThreadSettings>;
  setThreadAiEnabled(threadId: string, enabled: boolean): Promise<void>;

  getMemory(threadId: string): Promise<string>;
  setMemory(threadId: string, content: string): Promise<void>;

  getThreadStyle(threadId: string): Promise<ThreadStyle>;
  setThreadStyle(
    threadId: string,
    updates: {
      content?: string;
      auto_learn?: boolean;
      owner_msgs_since_learn?: number;
      access_mode?: "off" | "whitelist" | "blacklist";
      sources?: string[];
      active_persona?: string;
    }
  ): Promise<ThreadStyle>;

  /** Named personas for a thread (excludes the virtual 'default'). */
  getPersonas(threadId: string): Promise<Persona[]>;
  getPersona(threadId: string, name: string): Promise<Persona | null>;
  savePersona(threadId: string, name: string, content: string, sources?: string[]): Promise<Persona>;
  deletePersona(threadId: string, name: string): Promise<boolean>;

  getAccessList(threadId: string): Promise<AccessListData>;
  setAccessMode(threadId: string, mode: "off" | "whitelist" | "blacklist"): Promise<void>;
  addToAccessList(threadId: string, userId: string, listType: "white" | "black"): Promise<void>;
  removeFromAccessList(threadId: string, userId: string): Promise<void>;

  getGlobalBlacklist(): Promise<string[]>;
  addGlobalBlacklist(userId: string): Promise<void>;
  removeGlobalBlacklist(userId: string): Promise<void>;

  saveMessage(msg: MessageRecord): Promise<void>;
  getRecentMessages(threadId: string, limit?: number): Promise<MessageRecord[]>;

  recordBotMessage(messageId: string, threadId: string): Promise<void>;
  isBotMessage(messageId: string): Promise<boolean>;

  /** The owner's self-chat thread id (set via `.self set`), persisted in D1
   *  so it survives restarts. Falls back to SELF_THREAD_ID from .env. */
  getSelfThreadId(): Promise<string | null>;
  setSelfThreadId(threadId: string): Promise<void>;

  /** Typing-indicator work mode for a thread: 'user' = show the typing
   *  indicator while replying (duration ~ reply length, like a human
   *  typing); 'bot' = no indicator, reply as fast as possible. Default 'bot'. */
  getTypingMode(threadId: string): Promise<"user" | "bot">;
  setTypingMode(threadId: string, mode: "user" | "bot"): Promise<void>;

  /** "Active now" status: true = the account shows as Đang hoạt động
   *  (sidecar reports FOREGROUND app state + refreshes it); false =
   *  BACKGROUND, looks offline. Default true. */
  getPresenceEnabled(): Promise<boolean>;
  setPresenceEnabled(enabled: boolean): Promise<void>;

  purgeOldMessages(olderThanTimestamp: number): Promise<{ deletedMessages?: number; deletedBot?: number }>;
}
