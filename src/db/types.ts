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
  updated_at?: number | null;
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
    }
  ): Promise<ThreadStyle>;

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

  purgeOldMessages(olderThanTimestamp: number): Promise<{ deletedMessages?: number; deletedBot?: number }>;
}
