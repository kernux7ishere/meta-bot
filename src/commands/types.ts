import { MessengerClient, IncomingEvent } from "../messenger/types.js";

export interface CommandContext {
  client: MessengerClient;
  event: IncomingEvent;
  args: string[];
  rawText: string;
}

export type CommandHandler = (ctx: CommandContext) => Promise<void>;
