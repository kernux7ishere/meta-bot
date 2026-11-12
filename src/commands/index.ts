import { CommandHandler } from "./types.js";
import { aiCommand } from "./ai.js";
import { helpCommand } from "./help.js";
import { memoryCommand } from "./memory.js";
import { forgetCommand } from "./forget.js";
import { summaryCommand } from "./summary.js";
import { personaCommand } from "./persona.js";
import { listCommand } from "./list.js";
import { selfCommand } from "./self.js";
import { reactCommand } from "./react.js";
import { typingCommand } from "./typing.js";
import { presenceCommand } from "./presence.js";
import { modelCommand } from "./model.js";
import { stickerCommand } from "./sticker.js";

export const commands = new Map<string, CommandHandler>([
  ["ai", aiCommand],
  ["help", helpCommand],
  ["memory", memoryCommand],
  ["forget", forgetCommand],
  ["summary", summaryCommand],
  ["persona", personaCommand],
  ["list", listCommand],
  ["self", selfCommand],
  ["react", reactCommand],
  ["typing", typingCommand],
  ["presence", presenceCommand],
  ["model", modelCommand],
  ["sticker", stickerCommand],
]);
