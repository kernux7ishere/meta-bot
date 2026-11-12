import { AgentTool } from "./types.js";
import { searchWebTool } from "./search-web.js";
import { readUrlTool } from "./read-url.js";
import { readImageTool } from "./read-image.js";
import { readFileTool } from "./read-file.js";
import { rememberTool } from "./remember.js";
import { recordFactTool } from "./record-fact.js";
import { sendImageTool } from "./send-image.js";
import { sendFileTool } from "./send-file.js";
import { sendStickerTool } from "./send-sticker.js";
import { sendMessageTool } from "./send-message.js";
import { listMembersTool } from "./list-members.js";
import { remindTool } from "./remind.js";
import { reverseImageSearchTool } from "./reverse-image-search.js";

export const allTools: AgentTool[] = [
  searchWebTool,
  readUrlTool,
  readImageTool,
  readFileTool,
  rememberTool,
  recordFactTool,
  sendImageTool,
  sendFileTool,
  sendStickerTool,
  sendMessageTool,
  listMembersTool,
  remindTool,
  reverseImageSearchTool,
];

export const toolsByName = new Map<string, AgentTool>(
  allTools.map((t) => [t.definition.function.name, t])
);
