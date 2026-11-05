export interface MessengerAttachment {
  type: string;
  url?: string;
  previewUrl?: string;
  name?: string;
}

export interface IncomingEvent {
  type: "message" | "message_reply" | "event" | string;
  threadID: string;
  senderID: string;
  messageID: string;
  body?: string;
  attachments?: MessengerAttachment[];
  mentions?: Record<string, string>;
  messageReply?: {
    messageID: string;
    senderID: string;
    body?: string;
    attachments?: MessengerAttachment[];
  };
  timestamp?: number;
  isGroup?: boolean;
}

export interface MessengerClient {
  sendMessage(
    message: string | { body: string; mentions?: any; attachment?: any },
    threadID: string,
    replyToMessageID?: string
  ): Promise<string>;

  sendTypingIndicator(threadID: string): Promise<() => void>;

  getUserInfo(userID: string): Promise<{ name?: string }>;

  getThreadHistory?(threadID: string, amount: number, timestamp?: number): Promise<any[]>;

  getCurrentUserID(): string;

  listen(callback: (err: any, event: IncomingEvent) => void): () => void;
}
