import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fetchWithTimeout } from "./fetch-timeout.js";
import { isSafeUrl } from "../llm/guards.js";

export interface DownloadedFile {
  /** Absolute path to the temp file (caller must delete it when done). */
  path: string;
  filename: string;
  mime: string;
  size: number;
}

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "application/pdf": ".pdf",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "text/plain": ".txt",
};

/** Guess a filename from a URL's path, falling back to a generic name. */
export function filenameFromUrl(url: string, fallback = "file"): string {
  try {
    const pathname = new URL(url).pathname;
    const base = path.basename(pathname).split("?")[0];
    if (base && base.includes(".")) return base;
    return fallback;
  } catch {
    return fallback;
  }
}

/**
 * Download a URL to a temp file (with a size cap and a hard timeout).
 * Returns the temp path + metadata. The caller MUST delete `path` when
 * done (use try/finally). Throws on HTTP errors, oversize, or timeout.
 */
export async function downloadToTempFile(
  url: string,
  maxBytes: number,
  fallbackName = "file"
): Promise<DownloadedFile> {
  // Defense in depth: the agent-loop guard already checks URLs, but this
  // helper is the actual fetch point — refuse unsafe targets here too.
  const safe = isSafeUrl(url);
  if (!safe.safe) {
    throw new Error(`Refused unsafe URL: ${safe.reason}`);
  }
  const res = await fetchWithTimeout(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; MessengerBot/1.0)" },
  });
  if (!res.ok) {
    throw new Error(`Download failed: HTTP ${res.status} for ${url}`);
  }
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared > 0 && declared > maxBytes) {
    throw new Error(`File too large: ${Math.round(declared / 1024 / 1024)}MB (limit ${Math.round(maxBytes / 1024 / 1024)}MB)`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) {
    throw new Error(`File too large: ${Math.round(buf.length / 1024 / 1024)}MB (limit ${Math.round(maxBytes / 1024 / 1024)}MB)`);
  }
  if (buf.length === 0) {
    throw new Error(`Downloaded file is empty: ${url}`);
  }
  const mime = (res.headers.get("content-type") || "").split(";")[0].trim() || "application/octet-stream";
  let filename = filenameFromUrl(url, fallbackName);
  // Make sure the temp file has a usable extension for its MIME type so
  // Messenger displays it correctly (image vs generic file).
  const ext = path.extname(filename);
  if (!ext) {
    filename += EXT_BY_MIME[mime] || "";
  }
  const tmpPath = path.join(
    os.tmpdir(),
    `muse-bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${filename}`
  );
  fs.writeFileSync(tmpPath, buf);
  return { path: tmpPath, filename, mime, size: buf.length };
}

/** Delete a temp file, ignoring errors (best effort). */
export function removeTempFile(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch {
    // ignore
  }
}
