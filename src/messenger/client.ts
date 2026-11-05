import fs from "node:fs";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { IncomingEvent, MessengerClient } from "./types.js";
import { db } from "../db/index.js";

// @dongdev/fca-unofficial is a CommonJS module
// @ts-ignore
import loginDefault from "@dongdev/fca-unofficial";

export async function initMessenger(): Promise<MessengerClient> {
  const loginFn = typeof loginDefault === "function" ? loginDefault : (loginDefault as any).default;

  if (!fs.existsSync(config.appstatePath)) {
    throw new Error(
      `Appstate file not found at ${config.appstatePath}. Please export your Facebook cookies/appstate.json as described in the README.`
    );
  }

  let appState: any;
  try {
    const raw = fs.readFileSync(config.appstatePath, "utf-8");
    appState = JSON.parse(raw);
  } catch (err: any) {
    throw new Error(`Failed to parse appstate.json: ${err.message}`);
  }

  logger.info("Logging into Facebook Messenger via appstate...");

  return new Promise<MessengerClient>((resolve, reject) => {
    loginFn({ appState }, { listenEvents: true, selfListen: true, logLevel: "silent" }, (err: any, api: any) => {
      if (err) {
        logger.error({ err }, "Failed to login to Messenger");
        return reject(
          new Error(`Messenger login failed. Your appstate.json may have expired or is invalid. Details: ${JSON.stringify(err)}`)
        );
      }

      logger.info("Successfully connected to Facebook Messenger!");

      const currentUserId = api.getCurrentUserID();
      logger.info({ currentUserId }, "Current userbot account ID");

      const client: MessengerClient = {
        getCurrentUserID(): string {
          return currentUserId;
        },

        async sendMessage(message, threadID, replyToMessageID): Promise<string> {
          return new Promise<string>((res, rej) => {
            const msgPayload = typeof message === "string" ? { body: message } : message;

            api.sendMessage(msgPayload, threadID, async (sendErr: any, messageInfo: any) => {
              if (sendErr) {
                logger.error({ sendErr, threadID }, "Failed to send message");
                return rej(sendErr);
              }

              const sentId = messageInfo?.messageID;
              if (sentId) {
                // Register in DB as bot message
                await db.recordBotMessage(sentId, threadID).catch((e) => {
                  logger.warn({ err: e.message, sentId }, "Failed to record sent bot message");
                });
              }

              res(sentId || "");
            }, replyToMessageID);
          });
        },

        async sendTypingIndicator(threadID: string): Promise<() => void> {
          try {
            const endTyping = api.sendTypingIndicator(threadID);
            return () => {
              try {
                if (typeof endTyping === "function") {
                  endTyping();
                }
              } catch {
                // ignore
              }
            };
          } catch {
            return () => {};
          }
        },

        async getUserInfo(userID: string): Promise<{ name?: string }> {
          return new Promise((res) => {
            api.getUserInfo(userID, (err: any, ret: any) => {
              if (err || !ret || !ret[userID]) {
                return res({});
              }
              res({ name: ret[userID].name });
            });
          });
        },

        async getThreadHistory(threadID: string, amount: number, timestamp?: number): Promise<any[]> {
          return new Promise((res) => {
            if (typeof api.getThreadHistory !== "function") {
              return res([]);
            }
            api.getThreadHistory(threadID, amount, timestamp || undefined, (err: any, history: any[]) => {
              if (err || !Array.isArray(history)) {
                return res([]);
              }
              res(history);
            });
          });
        },

        listen(callback: (err: any, event: IncomingEvent) => void): () => void {
          const stopListening = api.listenMqtt((err: any, event: IncomingEvent) => {
            callback(err, event);
          });

          return () => {
            if (typeof stopListening === "function") {
              stopListening();
            }
          };
        },
      };

      resolve(client);
    });
  });
}
