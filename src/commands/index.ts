import { CommandHandler } from "./types.js";
import { aiCommand } from "./ai.js";
import { helpCommand } from "./help.js";
import { memoryCommand } from "./memory.js";
import { forgetCommand } from "./forget.js";
import { summaryCommand } from "./summary.js";
import { learnCommand } from "./learn.js";
import { listCommand } from "./list.js";
import { selfCommand } from "./self.js";

export const commands = new Map<string, CommandHandler>([
  ["ai", aiCommand],
  ["help", helpCommand],
  ["memory", memoryCommand],
  ["forget", forgetCommand],
  ["summary", summaryCommand],
  ["learn", learnCommand],
  ["list", listCommand],
  ["self", selfCommand],
]);
