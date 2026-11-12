import fs from "node:fs";
import { AgentTool } from "./types.js";
import { logger } from "../utils/logger.js";
import { downloadToTempFile, removeTempFile, filenameFromUrl } from "../utils/download.js";

/** Max file size Messenger accepts (25MB). */
const MAX_FILE_BYTES = 25 * 1024 * 1024;

export const sendFileTool: AgentTool = {
  definition: {
    type: "function",
    function: {
      name: "send_file",
      description:
        "Download a file from a URL and send it to the chat as a document/file attachment (PDF, Word, text, zip, ...). Use this when the user asks for a file/document to be sent to the chat, or shares a file link to forward. For images, prefer send_image so they show as pictures.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "Direct URL of the file to download and send.",
          },
          filename: {
            type: "string",
            description: "Optional filename to show in the chat (defaults to the name from the URL).",
          },
        },
        required: ["url"],
      },
    },
  },

  async execute(args: { url: string; filename?: string }, context): Promise<string> {
    const { url } = args;
    const client = context.client;
    if (!client) {
      return "Error: cannot send files — no live Messenger client in this run.";
    }
    if (!url || !url.startsWith("http")) {
      return "Error: a valid HTTP or HTTPS file URL is required.";
    }

    const wantName = args.filename || filenameFromUrl(url, "file");
    let downloaded;
    try {
      downloaded = await downloadToTempFile(url, MAX_FILE_BYTES, wantName);
    } catch (err: any) {
      logger.warn({ err: err.message, url }, "File download failed");
      return `Không tải được file (${err.message}).`;
    }

    try {
      // Go sidecar sends files by path (sendFile); fca takes a stream.
      if (typeof (client as any).sendFile === "function") {
        await (client as any).sendFile(
          downloaded.path,
          downloaded.filename,
          downloaded.mime,
          context.threadId
        );
      } else {
        const stream = fs.createReadStream(downloaded.path);
        await client.sendMessage(
          { body: "", attachment: stream },
          context.threadId
        );
      }
      logger.info({ url, size: downloaded.size, filename: downloaded.filename }, "File sent to thread");
      return `Đã gửi file "${downloaded.filename}" (${(downloaded.size / 1024).toFixed(0)} KB) lên chat.`;
    } catch (err: any) {
      logger.error({ err: err.message, url }, "Failed to send file");
      return `Gửi file thất bại: ${err.message}`;
    } finally {
      removeTempFile(downloaded.path);
    }
  },
};
