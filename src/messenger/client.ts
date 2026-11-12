import fs from "node:fs";
import { createRequire } from "node:module";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { IncomingEvent, MessengerClient } from "./types.js";
import { db } from "../db/index.js";
import { isStandardReaction } from "./reaction-picker.js";
import { pacedSend } from "./send-pacing.js";

// @dongdev/fca-unofficial ships both ESM (dist/index.mjs) and CJS (dist/cjs.cjs).
// The ESM bundle is broken in plain Node: its bundler shim throws
// 'Dynamic require of "util" is not supported' at load time. Load the CJS
// entry via createRequire instead (uses the package's `require` condition).
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const loginDefault = require("@dongdev/fca-unofficial");

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
          // Outbound pacing (anti-checkpoint): never fire message bursts.
          return pacedSend(
            () =>
              new Promise<string>((res, rej) => {
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
              })
          );
        },

        async sendTypingIndicator(threadID: string): Promise<() => void> {
          // dongdev signature: sendTypingIndicator(threadID, isTyping, options, callback).
          // isTyping=true starts typing. Messenger's client hides the indicator
          // ~5s after the last typing event, so a single send only shows ~5s —
          // it must be re-sent every few seconds to stay visible. Use
          // autoStop:false (no server-side auto-stop) and refresh every 3s;
          // stop explicitly with isTyping=false when done.
          const startOpts = { duration: 60000, autoStop: false };
          const stop = async () => {
            try {
              await api.sendTypingIndicator(threadID, false);
            } catch {}
          };
          try {
            await api.sendTypingIndicator(threadID, true, startOpts);
          } catch (err) {
            logger.warn({ err, threadID }, "sendTypingIndicator failed");
            return () => {};
          }
          const keepAlive = setInterval(() => {
            api.sendTypingIndicator(threadID, true, startOpts).catch(() => {});
          }, 3000);
          let stopped = false;
          return () => {
            if (stopped) return;
            stopped = true;
            clearInterval(keepAlive);
            stop();
          };
        },

        async setMessageReaction(reaction: string, messageID: string, threadID: string): Promise<void> {
          // Standard Facebook reactions; anything else is a custom emoji.
          const forceCustom = !isStandardReaction(reaction);
          return new Promise<void>((res, rej) => {
            api.setMessageReaction(reaction, messageID, threadID, (err: any) => {
              if (err) {
                logger.error({ err, reaction, messageID }, "Failed to set message reaction");
                return rej(err);
              }
              res();
            }, forceCustom);
          });
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
