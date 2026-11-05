import {
  AccessListData,
  DatabaseService,
  MessageRecord,
  ThreadSettings,
  ThreadStyle,
} from "./types.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { consolidateMemory } from "../llm/consolidation.js";

export class GatewayDatabaseClient implements DatabaseService {
  private baseUrl: string;
  private token: string;

  constructor() {
    this.baseUrl = config.gateway.url;
    this.token = config.gateway.token;
  }

  private isConfigured(): boolean {
    return Boolean(this.baseUrl && this.token);
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    if (!this.isConfigured()) {
      throw new Error("Cloudflare D1 Gateway is not configured (check GATEWAY_URL and GATEWAY_TOKEN in .env)");
    }

    const url = `${this.baseUrl}${endpoint}`;
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.token}`,
      ...(options.headers || {}),
    };

    const res = await fetch(url, {
      ...options,
      headers,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "Unknown error");
      throw new Error(`Gateway error (${res.status} ${res.statusText}): ${errText}`);
    }

    return (await res.json()) as T;
  }

  async getThreadSettings(threadId: string): Promise<ThreadSettings> {
    try {
      const data = await this.request<ThreadSettings>(`/thread/${encodeURIComponent(threadId)}`);
      return data;
    } catch (err: any) {
      logger.warn({ err: err.message, threadId }, "Failed to get thread settings, defaulting to disabled");
      return { thread_id: threadId, ai_enabled: false };
    }
  }

  async setThreadAiEnabled(threadId: string, enabled: boolean): Promise<void> {
    await this.request<{ success: boolean }>(`/thread/${encodeURIComponent(threadId)}`, {
      method: "POST",
      body: JSON.stringify({ ai_enabled: enabled }),
    });
  }

  async getMemory(threadId: string): Promise<string> {
    try {
      const data = await this.request<{ content: string }>(`/memory/${encodeURIComponent(threadId)}`);
      return data.content || "";
    } catch (err: any) {
      logger.warn({ err: err.message, threadId }, "Failed to get thread memory");
      return "";
    }
  }

  async setMemory(threadId: string, content: string): Promise<void> {
    let finalContent = content;
    if (finalContent.length > config.memoryMaxChars) {
      finalContent = await consolidateMemory(finalContent);
    }
    await this.request<{ success: boolean }>(`/memory/${encodeURIComponent(threadId)}`, {
      method: "POST",
      body: JSON.stringify({ content: finalContent }),
    });
  }

  async getThreadStyle(threadId: string): Promise<ThreadStyle> {
    try {
      const data = await this.request<ThreadStyle>(`/style/${encodeURIComponent(threadId)}`);
      return {
        ...data,
        sources: Array.isArray(data.sources) ? data.sources : [],
        access_mode: data.access_mode || "off",
      };
    } catch (err: any) {
      logger.warn({ err: err.message, threadId }, "Failed to get thread style");
      return {
        thread_id: threadId,
        content: "",
        auto_learn: false,
        owner_msgs_since_learn: 0,
        access_mode: "off",
        sources: [],
        updated_at: null,
      };
    }
  }

  async setThreadStyle(
    threadId: string,
    updates: {
      content?: string;
      auto_learn?: boolean;
      owner_msgs_since_learn?: number;
      access_mode?: "off" | "whitelist" | "blacklist";
      sources?: string[];
    }
  ): Promise<ThreadStyle> {
    const data = await this.request<ThreadStyle>(`/style/${encodeURIComponent(threadId)}`, {
      method: "POST",
      body: JSON.stringify(updates),
    });
    return {
      ...data,
      sources: Array.isArray(data.sources) ? data.sources : [],
      access_mode: data.access_mode || "off",
    };
  }

  async getAccessList(threadId: string): Promise<AccessListData> {
    try {
      const data = await this.request<AccessListData>(`/access/${encodeURIComponent(threadId)}`);
      return {
        thread_id: threadId,
        access_mode: data.access_mode || "off",
        whitelist: Array.isArray(data.whitelist) ? data.whitelist : [],
        blacklist: Array.isArray(data.blacklist) ? data.blacklist : [],
        global_blacklist: Array.isArray(data.global_blacklist) ? data.global_blacklist : [],
      };
    } catch (err: any) {
      logger.warn({ err: err.message, threadId }, "Failed to get access list");
      return { thread_id: threadId, access_mode: "off", whitelist: [], blacklist: [], global_blacklist: [] };
    }
  }

  async setAccessMode(threadId: string, mode: "off" | "whitelist" | "blacklist"): Promise<void> {
    await this.request<{ success: boolean }>(`/access/${encodeURIComponent(threadId)}`, {
      method: "POST",
      body: JSON.stringify({ action: "mode", mode }),
    });
  }

  async addToAccessList(threadId: string, userId: string, listType: "white" | "black"): Promise<void> {
    await this.request<{ success: boolean }>(`/access/${encodeURIComponent(threadId)}`, {
      method: "POST",
      body: JSON.stringify({ action: "add", user_id: userId, list_type: listType }),
    });
  }

  async removeFromAccessList(threadId: string, userId: string): Promise<void> {
    await this.request<{ success: boolean }>(`/access/${encodeURIComponent(threadId)}`, {
      method: "POST",
      body: JSON.stringify({ action: "remove", user_id: userId }),
    });
  }

  async getGlobalBlacklist(): Promise<string[]> {
    try {
      const data = await this.request<{ blacklist: string[] }>("/access/global");
      return Array.isArray(data.blacklist) ? data.blacklist : [];
    } catch (err: any) {
      logger.warn({ err: err.message }, "Failed to get global blacklist");
      return [];
    }
  }

  async addGlobalBlacklist(userId: string): Promise<void> {
    await this.request<{ success: boolean }>("/access/global", {
      method: "POST",
      body: JSON.stringify({ action: "ban", user_id: userId }),
    });
  }

  async removeGlobalBlacklist(userId: string): Promise<void> {
    await this.request<{ success: boolean }>("/access/global", {
      method: "POST",
      body: JSON.stringify({ action: "unban", user_id: userId }),
    });
  }

  async saveMessage(msg: MessageRecord): Promise<void> {
    try {
      await this.request<{ success: boolean }>("/messages", {
        method: "POST",
        body: JSON.stringify(msg),
      });
    } catch (err: any) {
      logger.error({ err: err.message, msgId: msg.id }, "Failed to save message to D1");
    }
  }

  async getRecentMessages(threadId: string, limit: number = config.historyLimit): Promise<MessageRecord[]> {
    try {
      const data = await this.request<{ messages: MessageRecord[] }>(
        `/messages/${encodeURIComponent(threadId)}?limit=${limit}`
      );
      return data.messages || [];
    } catch (err: any) {
      logger.warn({ err: err.message, threadId }, "Failed to get recent messages from D1");
      return [];
    }
  }

  async recordBotMessage(messageId: string, threadId: string): Promise<void> {
    try {
      await this.request<{ success: boolean }>("/bot-messages", {
        method: "POST",
        body: JSON.stringify({ id: messageId, thread_id: threadId, created_at: Date.now() }),
      });
    } catch (err: any) {
      logger.error({ err: err.message, messageId }, "Failed to record bot message");
    }
  }

  async isBotMessage(messageId: string): Promise<boolean> {
    try {
      const data = await this.request<{ is_bot: boolean }>(`/bot-messages/${encodeURIComponent(messageId)}`);
      return Boolean(data.is_bot);
    } catch (err: any) {
      logger.warn({ err: err.message, messageId }, "Failed to check if message was sent by bot");
      return false;
    }
  }

  async purgeOldMessages(olderThanTimestamp: number): Promise<{ deletedMessages?: number; deletedBot?: number }> {
    try {
      const res = await this.request<any>("/purge", {
        method: "POST",
        body: JSON.stringify({ older_than: olderThanTimestamp }),
      });
      return res;
    } catch (err: any) {
      logger.error({ err: err.message }, "Failed to purge old messages");
      return {};
    }
  }
}

/**
 * In-memory fallback database implementation when Cloudflare Worker gateway is not yet running.
 * This guarantees the userbot can run even during local development or when gateway isn't deployed yet.
 */
export class InMemoryDatabase implements DatabaseService {
  private threads = new Map<string, boolean>();
  private memory = new Map<string, string>();
  private styles = new Map<
    string,
    {
      content: string;
      auto_learn: boolean;
      owner_msgs_since_learn: number;
      access_mode: "off" | "whitelist" | "blacklist";
      sources: string[];
      updated_at: number;
    }
  >();
  private accessLists = new Map<string, Map<string, "white" | "black">>();
  private globalBlacklist = new Set<string>();
  private messages: MessageRecord[] = [];
  private botMessages = new Set<string>();

  async getThreadSettings(threadId: string): Promise<ThreadSettings> {
    return {
      thread_id: threadId,
      ai_enabled: this.threads.get(threadId) || false,
    };
  }

  async setThreadAiEnabled(threadId: string, enabled: boolean): Promise<void> {
    this.threads.set(threadId, enabled);
  }

  async getMemory(threadId: string): Promise<string> {
    return this.memory.get(threadId) || "";
  }

  async setMemory(threadId: string, content: string): Promise<void> {
    let finalContent = content;
    if (finalContent.length > config.memoryMaxChars) {
      finalContent = await consolidateMemory(finalContent);
    }
    this.memory.set(threadId, finalContent);
  }

  async getThreadStyle(threadId: string): Promise<ThreadStyle> {
    const s = this.styles.get(threadId);
    return {
      thread_id: threadId,
      content: s ? s.content : "",
      auto_learn: s ? s.auto_learn : false,
      owner_msgs_since_learn: s ? s.owner_msgs_since_learn : 0,
      access_mode: s ? s.access_mode : "off",
      sources: s && Array.isArray(s.sources) ? s.sources : [],
      updated_at: s ? s.updated_at : null,
    };
  }

  async setThreadStyle(
    threadId: string,
    updates: {
      content?: string;
      auto_learn?: boolean;
      owner_msgs_since_learn?: number;
      access_mode?: "off" | "whitelist" | "blacklist";
      sources?: string[];
    }
  ): Promise<ThreadStyle> {
    const existing = this.styles.get(threadId) || {
      content: "",
      auto_learn: false,
      owner_msgs_since_learn: 0,
      access_mode: "off" as const,
      sources: [] as string[],
      updated_at: Date.now(),
    };
    const updated = {
      content: updates.content !== undefined ? updates.content : existing.content,
      auto_learn: updates.auto_learn !== undefined ? updates.auto_learn : existing.auto_learn,
      owner_msgs_since_learn:
        updates.owner_msgs_since_learn !== undefined
          ? updates.owner_msgs_since_learn
          : existing.owner_msgs_since_learn,
      access_mode: updates.access_mode !== undefined ? updates.access_mode : existing.access_mode,
      sources: updates.sources !== undefined ? updates.sources : existing.sources,
      updated_at: Date.now(),
    };
    this.styles.set(threadId, updated);
    return {
      thread_id: threadId,
      ...updated,
    };
  }

  async getAccessList(threadId: string): Promise<AccessListData> {
    const style = await this.getThreadStyle(threadId);
    const listMap = this.accessLists.get(threadId) || new Map<string, "white" | "black">();
    const whitelist: string[] = [];
    const blacklist: string[] = [];

    for (const [userId, type] of listMap.entries()) {
      if (type === "white") whitelist.push(userId);
      else if (type === "black") blacklist.push(userId);
    }

    return {
      thread_id: threadId,
      access_mode: style.access_mode,
      whitelist,
      blacklist,
      global_blacklist: Array.from(this.globalBlacklist),
    };
  }

  async setAccessMode(threadId: string, mode: "off" | "whitelist" | "blacklist"): Promise<void> {
    await this.setThreadStyle(threadId, { access_mode: mode });
  }

  async addToAccessList(threadId: string, userId: string, listType: "white" | "black"): Promise<void> {
    let listMap = this.accessLists.get(threadId);
    if (!listMap) {
      listMap = new Map();
      this.accessLists.set(threadId, listMap);
    }
    listMap.set(userId, listType);
  }

  async removeFromAccessList(threadId: string, userId: string): Promise<void> {
    const listMap = this.accessLists.get(threadId);
    if (listMap) {
      listMap.delete(userId);
    }
  }

  async getGlobalBlacklist(): Promise<string[]> {
    return Array.from(this.globalBlacklist);
  }

  async addGlobalBlacklist(userId: string): Promise<void> {
    this.globalBlacklist.add(userId);
  }

  async removeGlobalBlacklist(userId: string): Promise<void> {
    this.globalBlacklist.delete(userId);
  }

  async saveMessage(msg: MessageRecord): Promise<void> {
    this.messages.push(msg);
    // Keep max 500 messages in memory to avoid memory leaks
    if (this.messages.length > 500) {
      this.messages = this.messages.slice(-500);
    }
  }

  async getRecentMessages(threadId: string, limit: number = config.historyLimit): Promise<MessageRecord[]> {
    const filtered = this.messages.filter((m) => m.thread_id === threadId);
    return filtered.slice(-limit);
  }

  async recordBotMessage(messageId: string): Promise<void> {
    this.botMessages.add(messageId);
  }

  async isBotMessage(messageId: string): Promise<boolean> {
    return this.botMessages.has(messageId);
  }

  async purgeOldMessages(olderThanTimestamp: number): Promise<{ deletedMessages?: number; deletedBot?: number }> {
    const initial = this.messages.length;
    this.messages = this.messages.filter((m) => m.created_at >= olderThanTimestamp);
    return { deletedMessages: initial - this.messages.length };
  }
}

export function createDatabaseClient(): DatabaseService {
  if (config.gateway.url && config.gateway.token) {
    logger.info({ url: config.gateway.url }, "Using Cloudflare D1 Gateway Database");
    return new GatewayDatabaseClient();
  }

  logger.warn("No GATEWAY_URL or GATEWAY_TOKEN provided; falling back to InMemoryDatabase");
  return new InMemoryDatabase();
}

export const db = createDatabaseClient();
