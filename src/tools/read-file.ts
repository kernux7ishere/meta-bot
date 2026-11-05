import { AgentTool } from "./types.js";
import { logger } from "../utils/logger.js";
import { truncate } from "../utils/text.js";
import mammoth from "mammoth";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");


export const readFileTool: AgentTool = {
  definition: {
    type: "function",
    function: {
      name: "read_file",
      description: "Download and extract text from an attached document file (PDF, DOCX, TXT, MD, CSV, JSON).",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "Direct download URL of the document file",
          },
          fileType: {
            type: "string",
            description: "Type or extension of the file: pdf, docx, txt, csv, json, md",
          },
        },
        required: ["url"],
      },
    },
  },

  async execute(args: { url: string; fileType?: string }): Promise<string> {
    const { url, fileType = "" } = args;

    if (!url) return "Error: file download URL is required.";

    logger.info({ url, fileType }, "Executing read_file");

    try {
      const res = await fetch(url);
      if (!res.ok) {
        return `Failed to download file: HTTP ${res.status} ${res.statusText}`;
      }

      const buffer = Buffer.from(await res.arrayBuffer());
      const ext = (fileType || url.split("?")[0].split(".").pop() || "").toLowerCase();

      // Check max file size (e.g., 10MB limit)
      if (buffer.length > 10 * 1024 * 1024) {
        return "Error: File size exceeds maximum limit of 10MB.";
      }

      let extractedText = "";

      if (ext === "pdf") {
        const data = await pdfParse(buffer);
        extractedText = data.text || "";
      } else if (ext === "docx") {
        const result = await mammoth.extractRawText({ buffer });
        extractedText = result.value || "";
      } else {
        // Plain text, markdown, csv, json
        extractedText = buffer.toString("utf-8");
      }

      if (!extractedText.trim()) {
        return "File was read successfully, but no text could be extracted.";
      }

      return `[UNTRUSTED FILE CONTENT START (type: ${ext})]\n${truncate(extractedText.trim(), 4000)}\n[UNTRUSTED FILE CONTENT END]`;
    } catch (err: any) {
      logger.error({ err: err.message, url }, "Failed to extract text from file");
      return `Failed to extract file text: ${err.message}`;
    }
  },
};
