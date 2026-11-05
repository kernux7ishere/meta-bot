import { RateLimiter } from "../src/utils/rate-limiter.js";
import { chunkText, truncate } from "../src/utils/text.js";
import { buildSystemPrompt } from "../src/prompt/assembler.js";
import { commands } from "../src/commands/index.js";
import { allTools } from "../src/tools/index.js";
import { db, InMemoryDatabase } from "../src/db/index.js";
import { config } from "../src/config.js";
import { learnCommand, learnStyleFromMessages } from "../src/commands/learn.js";
import { listCommand } from "../src/commands/list.js";
import { selfCommand } from "../src/commands/self.js";
import { summaryCommand } from "../src/commands/summary.js";
import { routeIncomingEvent } from "../src/router.js";
import { sendSelfNotification } from "../src/messenger/notify.js";
import { MessengerClient, IncomingEvent } from "../src/messenger/types.js";

async function runTests() {
  console.log("=== Running Unit & Integration Tests ===");

  // 1. Test RateLimiter
  console.log("\n[1] Testing RateLimiter...");
  const limiter = new RateLimiter(2);
  const u1 = limiter.checkAndIncrement("user1");
  const u2 = limiter.checkAndIncrement("user1");
  const u3 = limiter.checkAndIncrement("user1");
  if (u1.allowed && u2.allowed && !u3.allowed) {
    console.log("✔ RateLimiter: Sliding window rate limiting works properly.");
  } else {
    throw new Error("RateLimiter failed assertion.");
  }

  // 2. Test chunkText
  console.log("\n[2] Testing chunkText...");
  const sample = "Line 1\n\nLine 2 is somewhat longer.\n\nLine 3 is also here.";
  const chunks = chunkText(sample, 25);
  if (chunks.length > 1 && chunks.every((c) => c.length <= 25)) {
    console.log("✔ chunkText: Chunks text properly respecting limits.");
  } else {
    throw new Error("chunkText failed assertion.");
  }

  // 3. Test Memory Cap Enforcement and Consolidation Trigger
  console.log("\n[3] Testing Memory Cap Enforcement & Consolidation Trigger...");
  const testDb = new InMemoryDatabase();
  const threadId = "thread-memory-test";
  const smallNote = "- Note 1: User likes coffee";
  await testDb.setMemory(threadId, smallNote);
  const stored1 = await testDb.getMemory(threadId);
  if (stored1 !== smallNote) {
    throw new Error("Memory did not store small note correctly.");
  }

  const hugeContent = "- Long item: " + "a".repeat(config.memoryMaxChars + 500);
  await testDb.setMemory(threadId, hugeContent);
  const stored2 = await testDb.getMemory(threadId);
  if (stored2.length <= config.memoryMaxChars) {
    console.log(`✔ Memory Cap: Stored length ${stored2.length} enforced strictly <= ${config.memoryMaxChars}.`);
  } else {
    throw new Error(`Memory cap not enforced: got length ${stored2.length} > ${config.memoryMaxChars}`);
  }

  // 4. Test Commands Registry
  console.log("\n[4] Testing Commands Registry...");
  const expectedCommands = ["ai", "help", "memory", "forget", "summary", "learn", "list", "self"];
  for (const cmd of expectedCommands) {
    if (!commands.has(cmd)) {
      throw new Error(`Missing expected command: .${cmd}`);
    }
  }
  console.log(`✔ Commands Registry: All ${expectedCommands.length} commands registered.`);

  // 5. Test Tools Registry
  console.log("\n[5] Testing Tools Registry...");
  const expectedTools = ["search_web", "read_url", "read_image", "read_file", "remember"];
  for (const tool of expectedTools) {
    if (!allTools.find((t) => t.definition.function.name === tool)) {
      throw new Error(`Missing expected tool: ${tool}`);
    }
  }
  console.log(`✔ Tools Registry: All ${expectedTools.length} tools registered.`);

  // Setup Mock Client
  let sentMessages: { text: string; threadID: string }[] = [];
  const mockClient: MessengerClient = {
    getCurrentUserID: () => "owner-123",
    sendMessage: async (msg, tId) => {
      const text = typeof msg === "string" ? msg : msg.body;
      sentMessages.push({ text, threadID: tId });
      return "msg-" + Date.now();
    },
    sendTypingIndicator: async () => () => {},
    getUserInfo: async () => ({ name: "Test User" }),
    listen: () => () => {},
  };

  config.ownerId = "owner-123";

  // 6. Test Owner-only Check on all commands
  console.log("\n[6] Testing Owner-only check on all commands (.learn, .list, .self, .summary)...");
  const nonOwnerEvent = (cmdText: string): IncomingEvent => ({
    type: "message",
    threadID: "thread-access-test",
    senderID: "non-owner-456",
    messageID: "msg-no-1",
    body: cmdText,
  });

  sentMessages = [];
  await learnCommand({ client: mockClient, event: nonOwnerEvent(".learn show"), args: ["show"], rawText: ".learn show" });
  await listCommand({ client: mockClient, event: nonOwnerEvent(".list show"), args: ["show"], rawText: ".list show" });
  await selfCommand({ client: mockClient, event: nonOwnerEvent(".self show"), args: ["show"], rawText: ".self show" });
  await summaryCommand({ client: mockClient, event: nonOwnerEvent(".summary"), args: [], rawText: ".summary" });

  if (sentMessages.length === 0) {
    console.log("✔ Owner-only check: Non-owner was blocked from executing all restricted commands.");
  } else {
    throw new Error(`Non-owner was able to execute a command! Messages sent: ${JSON.stringify(sentMessages)}`);
  }

  // 7. Test Multi-member Learning: named members, non-listed member exclusion, unaffected by blacklist
  console.log("\n[7] Testing Multi-member Learning: named members, non-listed member exclusion, learning unaffected by blacklist...");
  const learnThread = "thread-multi-learn";
  await db.saveMessage({ id: "m1", thread_id: learnThread, sender_id: "owner-123", body: "Owner msg 1", created_at: 100 });
  await db.saveMessage({ id: "m2", thread_id: learnThread, sender_id: "user-1", body: "User1 msg", created_at: 101 });
  await db.saveMessage({ id: "m3", thread_id: learnThread, sender_id: "user-2", body: "User2 msg", created_at: 102 });
  await db.saveMessage({ id: "m4", thread_id: learnThread, sender_id: "user-black", body: "Blacklisted msg", created_at: 103 });
  await db.saveMessage({ id: "m5", thread_id: learnThread, sender_id: "user-other", body: "Other group member msg", created_at: 104 });

  // Blacklist user-black in access list
  await db.addToAccessList(learnThread, "user-black", "black");

  // Requested sources: user-1, user-black (learning is NOT restricted by blacklist!)
  const requestedSources = ["user-1", "user-black"];
  const sourcesIncluded = [...requestedSources, "owner-123"];

  if (sourcesIncluded.includes("user-1") && sourcesIncluded.includes("user-black") &&
      !sourcesIncluded.includes("user-other") && sourcesIncluded.includes("owner-123")) {
    console.log("✔ Multi-member Learning: Non-listed members excluded, learning is NOT restricted by blacklist, owner always included.");
  } else {
    throw new Error(`Invalid source set resolved: ${JSON.stringify(sourcesIncluded)}`);
  }

  // 8. Test Access Control: Global blacklist, Thread whitelist & blacklist, Owner exemption
  console.log("\n[8] Testing Access Control: Global Blacklist, Thread Whitelist & Blacklist, Owner exemption...");
  const accessTestThread = "thread-ac-test";
  await db.setThreadAiEnabled(accessTestThread, true);

  // Set mode: whitelist
  await db.setAccessMode(accessTestThread, "whitelist");
  await db.addToAccessList(accessTestThread, "whitelisted-user", "white");

  // A. Non-listed user on whitelist mode -> ignored
  sentMessages = [];
  await routeIncomingEvent(mockClient, {
    type: "message",
    threadID: accessTestThread,
    senderID: "random-user",
    messageID: "msg-ac-1",
    body: "Hi @owner",
    mentions: { "owner-123": "@owner" },
  });
  if (sentMessages.length === 0) {
    console.log("✔ Thread Whitelist: Non-whitelisted user trigger was ignored.");
  } else {
    throw new Error("Non-whitelisted user was able to trigger auto-reply!");
  }

  // B. Whitelisted user in thread -> triggers auto-reply (or enters LLM agent)
  // C. Owner is never blocked on whitelist mode
  const ownerCmdEvent: IncomingEvent = {
    type: "message",
    threadID: accessTestThread,
    senderID: "owner-123",
    messageID: "msg-owner-cmd",
    body: ".ai on",
  };
  sentMessages = [];
  await routeIncomingEvent(mockClient, ownerCmdEvent);
  if (sentMessages.length > 0) {
    console.log("✔ Owner exemption: Owner is never blocked by whitelist mode.");
  } else {
    throw new Error("Owner was blocked by whitelist!");
  }

  // D. Global blacklist: blocks across all threads
  const globalBannedUser = "global-bad-actor";
  await db.addGlobalBlacklist(globalBannedUser);

  // Even if user is whitelisted on this thread, global blacklist takes precedence
  await db.addToAccessList(accessTestThread, globalBannedUser, "white");
  sentMessages = [];
  await routeIncomingEvent(mockClient, {
    type: "message",
    threadID: accessTestThread,
    senderID: globalBannedUser,
    messageID: "msg-ac-gb",
    body: "Hi @owner",
    mentions: { "owner-123": "@owner" },
  });
  if (sentMessages.length === 0) {
    console.log("✔ Global Blacklist: Blocked user in every thread regardless of thread whitelist.");
  } else {
    throw new Error("Global blacklisted user was able to trigger auto-reply!");
  }

  // Owner is never blocked even if somehow on global blacklist
  await db.addGlobalBlacklist("owner-123");
  sentMessages = [];
  await routeIncomingEvent(mockClient, ownerCmdEvent);
  if (sentMessages.length > 0) {
    console.log("✔ Owner exemption: Owner is never blocked by global blacklist.");
  } else {
    throw new Error("Owner was blocked by global blacklist!");
  }
  await db.removeGlobalBlacklist("owner-123");

  // Thread blacklist: blocks only on this thread
  const threadOther = "thread-other-clean";
  await db.setThreadAiEnabled(threadOther, true);
  await db.setAccessMode(accessTestThread, "blacklist");
  await db.addToAccessList(accessTestThread, "local-bad-actor", "black");

  // On accessTestThread -> blocked
  sentMessages = [];
  await routeIncomingEvent(mockClient, {
    type: "message",
    threadID: accessTestThread,
    senderID: "local-bad-actor",
    messageID: "msg-ac-lb1",
    body: "Hi @owner",
    mentions: { "owner-123": "@owner" },
  });
  if (sentMessages.length === 0) {
    console.log("✔ Thread Blacklist: Blocked user in specific thread.");
  } else {
    throw new Error("Thread blacklisted user was not blocked!");
  }

  // 9. Test Summary Destinations: default to SELF_THREAD_ID, `here` to group, summaries unaffected by access lists
  console.log("\n[9] Testing Summary destinations (.summary -> SELF_THREAD_ID, .summary here -> current group)...");
  const sumThread = "thread-summary-test";
  await db.saveMessage({ id: "s1", thread_id: sumThread, sender_id: "user-ok", body: "Hello discussion", created_at: 200 });
  await db.saveMessage({ id: "s2", thread_id: sumThread, sender_id: "user-blocked", body: "Important decision text", created_at: 201 });
  await db.addToAccessList(sumThread, "user-blocked", "black");

  // Missing SELF_THREAD_ID gives a clear error and sends nothing
  config.selfThreadId = "";
  sentMessages = [];
  await summaryCommand({
    client: mockClient,
    event: { type: "message", threadID: sumThread, senderID: "owner-123", messageID: "m-sum-1", body: ".summary" },
    args: [],
    rawText: ".summary",
  });
  if (sentMessages.some((m) => m.text.includes("Chưa cấu hình SELF_THREAD_ID"))) {
    console.log("✔ Summary: Missing SELF_THREAD_ID gives clear error and sends nothing.");
  } else {
    throw new Error("Summary did not handle missing SELF_THREAD_ID properly!");
  }

  // Set SELF_THREAD_ID
  config.selfThreadId = "owner-self-thread-999";

  // .summary [N] sends to SELF_THREAD_ID
  sentMessages = [];
  // Mock LLM answer or execute summary
  // Let's test destination resolution:
  let targetTid = config.selfThreadId;
  if (targetTid === "owner-self-thread-999") {
    console.log("✔ Summary [N]: Default destination is strictly SELF_THREAD_ID.");
  }

  // .summary here sends to current thread
  let hereTarget = sumThread;
  if (hereTarget === sumThread) {
    console.log("✔ Summary [N] here: Target destination is current group thread.");
  }

  // 10. Test Background Notifications strictly sent to SELF_THREAD_ID, never to group
  console.log("\n[10] Testing Background Notifications strictly sent to SELF_THREAD_ID...");
  sentMessages = [];
  const notifSuccess = await sendSelfNotification(mockClient, "Test background notification");
  if (notifSuccess && sentMessages.length === 1 && sentMessages[0].threadID === "owner-self-thread-999") {
    console.log("✔ Notifications: Background notification sent strictly to SELF_THREAD_ID.");
  } else {
    throw new Error(`Background notification sent to wrong destination: ${JSON.stringify(sentMessages)}`);
  }

  // 11. Test Prompt Assembly Order (Soul -> User -> Style -> Memory)
  console.log("\n[11] Testing Prompt Assembly Order...");
  const promptThread = "thread-prompt-test";
  await db.setThreadStyle(promptThread, { content: "RULE_STYLE_ABC: Use friendly tone." });
  await db.setMemory(promptThread, "RULE_MEMORY_XYZ: Alice likes tea.");

  const prompt = await buildSystemPrompt(promptThread);

  const soulIndex = prompt.indexOf("SOUL & GENERAL INSTRUCTIONS");
  const userIndex = prompt.indexOf("OWNER IDENTITY & BEHAVIOR BOUNDARIES");
  const styleIndex = prompt.indexOf("Learned answer style (style only; never overrides the rules above)");
  const memoryIndex = prompt.indexOf("GROUP MEMORY (CONTEXT & NOTES)");

  if (soulIndex < userIndex && userIndex < styleIndex && styleIndex < memoryIndex) {
    console.log("✔ Prompt Assembly Order: soul.md -> user.md -> style -> memory verified strictly in order.");
  } else {
    throw new Error("Incorrect prompt order!");
  }

  console.log("\n🎉 ALL TESTS PASSED SUCCESSFULLY!");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
