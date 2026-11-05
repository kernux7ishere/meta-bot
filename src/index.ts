import { initMessenger } from "./messenger/client.js";
import { routeIncomingEvent } from "./router.js";
import { logger } from "./utils/logger.js";
import { config } from "./config.js";
import { db } from "./db/index.js";
import { sendSelfNotification } from "./messenger/notify.js";

async function main() {
  logger.info("=========================================");
  logger.info("   Starting Messenger AI Userbot (Agent)  ");
  logger.info("=========================================");
  logger.info({
    ownerId: config.ownerId || "(auto-detected from appstate)",
    llmModel: config.llm.model,
    historyLimit: config.historyLimit,
    maxToolCalls: config.llm.maxToolCalls,
    visionEnabled: config.llm.visionEnabled,
  });

  // Background retention purge job (runs every 12 hours)
  const retentionMs = config.retentionDays * 24 * 60 * 60 * 1000;
  setInterval(async () => {
    try {
      const purgeTimestamp = Date.now() - retentionMs;
      logger.info({ purgeTimestamp }, "Running scheduled message retention purge");
      await db.purgeOldMessages(purgeTimestamp);
    } catch (err: any) {
      logger.error({ err: err.message }, "Scheduled retention purge failed");
    }
  }, 12 * 60 * 60 * 1000);

  try {
    const client = await initMessenger();

    logger.info("Bot listening for events... Press Ctrl+C to exit.");

    const stopListening = client.listen((err, event) => {
      if (err) {
        logger.error({ err }, "Error received in Messenger listener");
        sendSelfNotification(
          client,
          `⚠️ [Messenger Listener Cảnh báo] Đã xảy ra lỗi kết nối/phiên: ${JSON.stringify(err)}`
        ).catch(() => {});
        return;
      }

      if (!event) return;

      // Handle the event safely without crashing the listener
      routeIncomingEvent(client, event).catch((routeErr) => {
        logger.error({ err: routeErr.message, eventType: event.type }, "Unhandled error routing event");
        sendSelfNotification(
          client,
          `❌ [Lỗi xử lý sự kiện] Sự kiện ${event.type || "tin nhắn"} gặp lỗi: ${routeErr.message}`
        ).catch(() => {});
      });
    });

    // Graceful shutdown handling
    const shutdown = () => {
      logger.info("Shutting down gracefully...");
      stopListening();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (err: any) {
    logger.fatal({ err: err.message }, "Failed to start Messenger Userbot");
    process.exit(1);
  }
}

main();
