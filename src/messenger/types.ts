export interface MessengerAttachment {
  type: string;
  url?: string;
  previewUrl?: string;
  name?: string;
  /** Mime type, when the client reports it (Go sidecar only). */
  mime?: string;
  /** File size in bytes, when the client reports it (Go sidecar only). */
  size?: number;
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
  /** True when this message arrived over E2EE (Go sidecar only). */
  isE2EE?: boolean;
  /** Sticker the sender attached, as a numeric id string (Go sidecar only;
   *  present on sticker-only messages too). The bot learns stickers the
   *  owner sends and adds them to its sticker pack. */
  stickerID?: string;
  /** Direct image URL of the attached sticker (Go sidecar only; the
   *  LSInsertStickerAttachment ImageUrl). Lets the bot describe the
   *  sticker with vision for semantic sticker search — an id alone says
   *  nothing about what the sticker shows. Absent for animated stickers
   *  and in E2EE threads. */
  stickerUrl?: string;
}

export interface ThreadMember {
  userID: string;
  name?: string;
}

export interface MessengerClient {
  sendMessage(
    message:
      | string
      | { body: string; mentions?: any; attachment?: any; sticker?: string | number },
    threadID: string,
    replyToMessageID?: string,
    /** Sender of the message being replied to (E2EE quote-reply: the
     *  sidecar uses it as the <fbid>@msgr participant). Omitted when
     *  unknown — the quote then carries only the message id. */
    replyToSenderID?: string
  ): Promise<string>;

  /** Send a local file as an attachment (image/file). The Go sidecar
   *  uploads it and sends it as a MEDIA message; the fca client has no
   *  equivalent and omits it (its sendMessage accepts a stream instead). */
  sendFile?(
    filePath: string,
    filename: string,
    mimeType: string,
    threadID: string,
    caption?: string,
    replyToMessageID?: string
  ): Promise<string>;

  /** List the thread's participants (Go sidecar only; the fca client has
   *  no equivalent and omits it). Names may be empty (per-thread nickname
   *  only); userID is what @mentions need. */
  getThreadMembers?(threadID: string): Promise<ThreadMember[]>;

  sendTypingIndicator(threadID: string): Promise<() => void>;

  /** Set the account's Active status ("Đang hoạt động"): the Go
   *  sidecar reports FOREGROUND app state while on, BACKGROUND while
   *  off. Best-effort — a failure is logged, not thrown. The fca
   *  client has no equivalent and omits it. */
  setPresence?(active: boolean): Promise<void>;

  /** Add an emoji reaction to a message (e.g. "❤️", "👍", "😆"). */
  setMessageReaction(reaction: string, messageID: string, threadID: string): Promise<void>;

  getUserInfo(userID: string): Promise<{ name?: string }>;

  getThreadHistory?(threadID: string, amount: number, timestamp?: number): Promise<any[]>;

  getCurrentUserID(): string;

  listen(callback: (err: any, event: IncomingEvent) => void): () => void;

  /** Optional: shut the underlying client down (the Go bridge stops its
   *  sidecar process; the fca client has no equivalent and omits it). */
  disconnect?(): Promise<void>;
}
