import { AgentTool } from "./types.js";
import { logger } from "../utils/logger.js";
import { fetchWithTimeout } from "../utils/fetch-timeout.js";

interface ReverseImageResult {
  /** Exact/near-exact copies of the image found elsewhere (best for finding the source). */
  duplicates: Array<{ url: string; size: string }>;
  /** Visually similar images with their titles. */
  similar: Array<{ title: string; url: string }>;
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/** Parse a Yandex reverse-image-search page into duplicates + similar images. */
function parseYandexResults(html: string): ReverseImageResult {
  const text = decodeHtmlEntities(html);
  const duplicates: Array<{ url: string; size: string }> = [];
  const similar: Array<{ title: string; url: string }> = [];

  // Exact duplicates: {"group":"large_dups","text":"1795×2397","description":"...","url":"https://..."}
  // Prefer large_dups (highest resolution), then medium, then small.
  const dupRe = /\{"group":"(large|medium|small)_dups","text":"([^"]*)","description":"[^"]*","url":"([^"]+)"/g;
  const dupBySize: Record<string, Array<{ url: string; size: string }>> = { large: [], medium: [], small: [] };
  let m: RegExpExecArray | null;
  while ((m = dupRe.exec(text)) !== null) {
    const [, size, dims, url] = m;
    if (url.startsWith("http")) {
      dupBySize[size].push({ url, size: dims });
    }
  }
  const orderedDups = [...dupBySize.large, ...dupBySize.medium, ...dupBySize.small];
  const seenDup = new Set<string>();
  for (const d of orderedDups) {
    if (seenDup.has(d.url)) continue;
    seenDup.add(d.url);
    duplicates.push(d);
    if (duplicates.length >= 8) break;
  }

  // Similar images: items with a title and a linkUrl containing img_url=<encoded image url>
  const simRe = /"title":"([^"]{2,150})","linkUrl":"[^"]*?img_url=([^"&]+)/g;
  const seenSim = new Set<string>();
  while ((m = simRe.exec(text)) !== null) {
    const [, title, encodedUrl] = m;
    let url = encodedUrl;
    try {
      url = decodeURIComponent(encodedUrl);
    } catch {
      // keep as-is
    }
    if (!url.startsWith("http") || seenSim.has(url)) continue;
    seenSim.add(url);
    similar.push({ title: title.trim(), url });
    if (similar.length >= 8) break;
  }

  return { duplicates, similar };
}

/** Reverse image search via Yandex (free, no key, works well for memes). */
export async function reverseImageSearchYandex(imageUrl: string): Promise<ReverseImageResult> {
  const searchUrl =
    "https://yandex.com/images/search?rpt=imageview&url=" + encodeURIComponent(imageUrl);
  const res = await fetchWithTimeout(searchUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
    },
  }, 30000);
  if (!res.ok) {
    throw new Error(`Yandex reverse search failed: HTTP ${res.status}`);
  }
  const html = await res.text();
  if (/captcha/i.test(html) && /smartcaptcha|showcaptcha/i.test(html)) {
    throw new Error("Yandex asked for a captcha — reverse search is temporarily blocked. Try again later.");
  }
  return parseYandexResults(html);
}

export const reverseImageSearchTool: AgentTool = {
  definition: {
    type: "function",
    function: {
      name: "reverse_image_search",
      description:
        "Find where an image comes from (reverse image search). Give the direct URL of an image or sticker already in the chat and it returns pages/images that contain the same picture (exact duplicates — best for finding the source) and visually similar images. Use this when the user asks where an image/sticker/meme came from, or wants to find the original source of a picture.",
      parameters: {
        type: "object",
        properties: {
          image_url: {
            type: "string",
            description: "Direct URL of the image to search for (e.g. the sticker/photo URL from the message context).",
          },
        },
        required: ["image_url"],
      },
    },
  },

  async execute(args: { image_url: string }): Promise<string> {
    const { image_url } = args;
    if (!image_url || !image_url.startsWith("http")) {
      return "Error: a valid HTTP or HTTPS image URL is required for reverse image search.";
    }
    logger.info({ image_url }, "Reverse image search via Yandex");
    let result: ReverseImageResult;
    try {
      result = await reverseImageSearchYandex(image_url);
    } catch (err: any) {
      logger.warn({ err: err.message, image_url }, "Reverse image search failed");
      return `Tìm ảnh ngược thất bại: ${err.message}`;
    }

    const lines: string[] = [];
    if (result.duplicates.length > 0) {
      lines.push(`**Ảnh giống hệt (bản sao) — ${result.duplicates.length} kết quả:**`);
      for (const d of result.duplicates) {
        let domain = "";
        try {
          domain = new URL(d.url).hostname;
        } catch {
          domain = "";
        }
        lines.push(`- ${d.url}${domain ? ` (từ ${domain})` : ""}${d.size ? ` [${d.size}]` : ""}`);
      }
    } else {
      lines.push("Không tìm thấy bản sao giống hệt của ảnh này.");
    }
    if (result.similar.length > 0) {
      lines.push(`\n**Ảnh tương tự — ${result.similar.length} kết quả:**`);
      for (const s of result.similar) {
        lines.push(`- ${s.title} — ${s.url}`);
      }
    }
    if (result.duplicates.length === 0 && result.similar.length === 0) {
      return "Không tìm thấy ảnh này hay ảnh tương tự ở đâu cả. Có thể đây là ảnh chế cá nhân / ảnh ghép, không có nguồn công khai.";
    }
    return lines.join("\n");
  },
};
