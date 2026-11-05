import { AgentTool } from "./types.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { getLlmClient } from "../llm/client.js";

export const readImageTool: AgentTool = {
  definition: {
    type: "function",
    function: {
      name: "read_image",
      description: "Analyze, understand, or extract text from an image provided via URL or attachment.",
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
                  url: url,
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
