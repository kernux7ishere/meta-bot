import { AgentTool } from "./types.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { getLlmClient } from "../llm/client.js";
import { safeFetch } from "../utils/safe-fetch.js";

/** Detect a real image MIME type from file magic bytes (the upstream rejects
 *  the generic `image/*` it guesses when it fetches a URL itself). */
function detectImageMime(buf: Buffer, contentType: string | null): string {
  if (contentType && /^image\/(jpeg|png|gif|webp|bmp|avif)$/i.test(contentType.trim())) {
    return contentType.trim().toLowerCase();
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 6 && buf.toString("ascii", 0, 6).startsWith("GIF8")) return "image/gif";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return "image/bmp";
  return "image/jpeg";
}

/** Download an image URL to a base64 data URI with a concrete MIME type.
 *  The LLM upstream cannot fetch Facebook CDN URLs reliably (it guesses
 *  mime `image/*`, which Gemini rejects), so the bot fetches the bytes. */
async function urlToDataUri(url: string): Promise<string> {
  // SSRF-safe fetch: resolves + checks the host and every redirect hop
  // (read_image was not covered by the guard's URL_TOOLS before — the
  // fetch went out unchecked).
  const res = await safeFetch(
    url,
    {
      headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36" },
    },
    20000
  );
  if (!res.ok) throw new Error(`Image download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error("Image download returned empty body");
  if (buf.length > 10 * 1024 * 1024) throw new Error("Image is larger than 10 MB");
  const mime = detectImageMime(buf, res.headers.get("content-type"));
  return `data:${mime};base64,${buf.toString("base64")}`;
}

export const readImageTool: AgentTool = {
  definition: {
    type: "function",
    function: {
      name: "read_image",
      description:
        "Analyze, understand, or extract text from an image provided via URL or attachment. A Messenger sticker IS an image — when the user asks about a sticker (or a photo) sent in this thread, call this with that sticker/photo's URL from the message context. Use it to describe, read, or transcribe any image or sticker the user refers to.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "Direct URL of the image to analyze",
          },
          prompt: {
            type: "string",
            description: "Specific question or instruction about the image (e.g. 'Extract all text' or 'Describe the chart')",
          },
        },
        required: ["url"],
      },
    },
  },

  async execute(args: { url: string; prompt?: string }): Promise<string> {
    const { url, prompt = "Describe this image in detail and extract any readable text." } = args;

    if (!config.llm.visionEnabled) {
      return "Vision capabilities are currently disabled in configuration (LLM_VISION=false).";
    }

    if (!url) {
      return "Error: Image URL is required.";
    }

    logger.info({ url }, "Executing read_image");

    try {
      const client = getLlmClient();

      // Fetch the image ourselves and send it as base64 with a concrete
      // MIME type (the upstream cannot fetch fbcdn URLs reliably).
      const imageUrl = url.startsWith("data:") ? url : await urlToDataUri(url);

      const response = await client.chat.completions.create({
        model: config.llm.model,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: prompt,
              },
              {
                type: "image_url",
                image_url: {
                  url: imageUrl,
                },
              },
            ],
          },
        ],
        max_tokens: 800,
      });

      const analysis = response.choices[0]?.message?.content || "No analysis generated.";
      return `[UNTRUSTED IMAGE ANALYSIS DATA START]\n${analysis}\n[UNTRUSTED IMAGE ANALYSIS DATA END]`;
    } catch (err: any) {
      logger.error({ err: err.message, url }, "Failed to analyze image");
      return `Failed to analyze image: ${err.message}`;
    }
  },
};
