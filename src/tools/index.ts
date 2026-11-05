import { AgentTool } from "./types.js";
import { searchWebTool } from "./search-web.js";
import { readUrlTool } from "./read-url.js";
import { readImageTool } from "./read-image.js";
import { readFileTool } from "./read-file.js";
import { rememberTool } from "./remember.js";

export const allTools: AgentTool[] = [
  searchWebTool,
  readUrlTool,
  readImageTool,
  readFileTool,
  rememberTool,
];

export const toolsByName = new Map<string, AgentTool>(
  allTools.map((t) => [t.definition.function.name, t])
);
