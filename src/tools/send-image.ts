import fs from "node:fs";
import { AgentTool } from "./types.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { fetchWithTimeout } from "../utils/fetch-timeout.js";
import { downloadToTempFile, removeTempFile } from "../utils/download.js";
import { getSentImageUrls, recordSentImage } from "../sent-images.js";

/** Max image size Messenger will accept comfortably. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

interface CommonsImage {
  title: string;
  url: string;
  mime: string;
}

/** Search Wikimedia Commons for free images matching a query. */
async function searchCommonsImages(query: string, limit = 5): Promise<CommonsImage[]> {
  const apiUrl =
    "https://commons.wikimedia.org/w/api.php?action=query&generator=search" +
    `&gsrsearch=${encodeURIComponent(query)}&gsrnamespace=6&gsrlimit=${limit}` +
    "&prop=imageinfo&iiprop=url%7Cmime&format=json";
  const res = await fetchWithTimeout(apiUrl, {
    headers: { "User-Agent": "MessengerBot/1.0 (contact: userbot)" },
  });
  if (!res.ok) {
    throw new Error(`Image search failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as any;
  const pages = Object.values(data?.query?.pages || {}) as any[];
  const images: CommonsImage[] = [];
  for (const p of pages) {
    const info = p?.imageinfo?.[0];
    if (!info?.url || !info?.mime?.startsWith("image/")) continue;
    images.push({ title: p.title || "", url: info.url, mime: info.mime });
  }
  return images;
}

export const sendImageTool: AgentTool = {
  definition: {
    type: "function",
    function: {
      name: "send_image",
      description:
        "Find an image and send it to the chat as a picture. Give either a search query (e.g. 'con mèo', 'sunset beach') to find a free image, or a direct image URL to send that exact image. When searching, images already sent in this thread are skipped automatically, so 'another photo' always means a different file — pass the same query again and the next unsent result is picked. Use this when the user asks for a picture/photo to be sent to the chat.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search keywords for the image to find and send (e.g. 'con mèo').",
          },
          url: {
            type: "string",
            description: "Direct URL of an image to send (use instead of query when a specific image URL is known).",
          },
          index: {
            type: "number",
            description: "Which search result to send (0 = first). Default 0.",
          },
        },
      },
    },
  },

  async execute(args: { query?: string; url?: string; index?: number }, context): Promise<string> {
    const { query, url, index = 0 } = args;
    const client = context.client;
    if (!client) {
      return "Error: cannot send images — no live Messenger client in this run.";
    }
    if (!query && !url) {
      return "Error: provide either a search query or an image URL.";
    }

    let imageUrl = url || "";
    let title = "";
    if (!imageUrl && query) {
      logger.info({ query }, "Searching Wikimedia Commons for an image to send");
      const images = await searchCommonsImages(query, 5);
      if (images.length === 0) {
        return `Không tìm thấy ảnh nào cho "${query}". Thử từ khóa khác nhé.`;
      }
      // Skip images already sent in this thread — otherwise "ảnh khác"
      // re-sends the same file (the agent defaults to index 0 and has no
      // memory of what it sent). The requested index counts among the
      // UNSENT results, so index 0 = the first image not sent yet.
      const sent = new Set(getSentImageUrls(context.threadId));
      const norm = (u: string) => {
        try {
          const parsed = new URL(u);
          return `${parsed.origin}${parsed.pathname}`;
        } catch {
          return u.split("?")[0];
        }
      };
      const unsent = images.filter((img) => !sent.has(norm(img.url)));
      if (unsent.length === 0) {
        return `Đã gửi hết ${images.length} ảnh tìm được cho "${query}" rồi, không còn tấm nào khác. Thử từ khóa khác nhé.`;
      }
      const pick = unsent[Math.min(Math.max(index, 0), unsent.length - 1)];
      imageUrl = pick.url;
      title = pick.title;
    }

    let downloaded;
    try {
      downloaded = await downloadToTempFile(imageUrl, MAX_IMAGE_BYTES, "image");
    } catch (err: any) {
      logger.warn({ err: err.message, imageUrl }, "Image download failed");
      return `Không tải được ảnh (${err.message}).`;
    }

    try {
      if (!downloaded.mime.startsWith("image/")) {
        return `URL đó không phải là ảnh (loại: ${downloaded.mime}).`;
      }
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
      const label = title ? ` "${title.replace(/^File:/, "")}"` : "";
      logger.info({ imageUrl, size: downloaded.size }, "Image sent to thread");
      // Record it so the next "ảnh khác" skips this file — and so the
      // agent's next turn knows WHAT it sent ("mô tả nó" needs the URL).
      recordSentImage(context.threadId, imageUrl, { query, title });
      return `Đã gửi ảnh${label} lên chat.`;
    } catch (err: any) {
      logger.error({ err: err.message, imageUrl }, "Failed to send image");
      return `Gửi ảnh thất bại: ${err.message}`;
    } finally {
      removeTempFile(downloaded.path);
    }
  },
};
