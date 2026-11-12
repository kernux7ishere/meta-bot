/**
 * Pick a reaction emoji for a message — diverse and context-aware, not a
 * fixed template. The pick is driven by what the message actually says:
 * mirror an emoji the sender used, match the message's tone/topic via
 * keywords, and randomise within the matched group so the same kind of
 * message doesn't always get the same reaction. A small chance of a
 * surprise pick keeps it spontaneous.
 *
 * Keyword matching is word-boundary based (on diacritic-stripped,
 * lowercased text) so "an" never matches inside "ban" and "oi" never
 * matches inside "roi"/"moi". Idioms are handled explicitly: "buồn cười"
 * is funny (not sad) and "ngủ ngon" is sleep (not food).
 */

const STANDARD_REACTIONS = ["👍", "❤️", "😆", "😮", "😢", "😡"];

/** Broad fallback pool used when nothing specific matches. */
const DEFAULT_POOL = [
  "❤️", "👍", "😊", "🔥", "✨", "🙌", "😄", "💡", "🤗", "🌟",
  "😆", "🥰", "👏", "💯", "😎",
];

interface Category {
  test: (text: string) => boolean;
  emojis: string[];
}

/** Vietnamese diacritics stripped so "cảm ơn" and "cam on" match alike. */
function stripDiacritics(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D");
}

/** Word-boundary phrase match (so "an" doesn't match inside "ban",
 *  and "oi" doesn't match inside "roi"/"moi"). `text` must be the
 *  normalized, lowercased message with punctuation turned into spaces. */
function hasPhrase(text: string, phrase: string): boolean {
  const padded = ` ${text} `;
  return padded.includes(` ${phrase} `);
}

function hasAny(text: string, words: string[]): boolean {
  return words.some((w) => hasPhrase(text, w));
}

/** Normalize for keyword matching: lowercase, no diacritics, punctuation
 *  (except ? and !) turned into spaces, collapsed to single spaces. */
function normalizeForMatch(raw: string): string {
  return stripDiacritics(raw.toLowerCase())
    .replace(/[^\p{L}\p{N}?!]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const CATEGORIES: Category[] = [
  {
    // Question -> curious / thinking
    test: (t) => t.includes("?"),
    emojis: ["🤔", "🧐", "💡", "🤨", "👀"],
  },
  {
    // Thanks -> warm
    test: (t) => hasAny(t, ["cam on", "thanks", "thank", "thank you"]),
    emojis: ["❤️", "🥰", "😊", "🙏", "🤗"],
  },
  {
    // Greeting -> friendly wave
    test: (t) => hasAny(t, ["xin chao", "chao", "hello", "hi", "hey", "alo", "yo"]),
    emojis: ["👋", "😊", "🙌", "🤗", "😄"],
  },
  {
    // Laugh / funny -> laugh along ("buồn cười" is funny, not sad)
    test: (t) => hasAny(t, ["haha", "hehe", "hihi", "lol", "hai", "cuoi", "buon cuoi", "vai"]),
    emojis: ["😆", "😂", "🤣", "😹", "😄"],
  },
  {
    // Sad / tired / unlucky -> comfort (but not "buồn cười" = funny)
    test: (t) => hasAny(t, ["buon", "chan", "met", "khoc", "te", "xui", "that vong"]) && !hasPhrase(t, "buon cuoi"),
    emojis: ["😢", "🥺", "🤗", "💔", "🫂"],
  },
  {
    // Love / like -> affection
    test: (t) => hasAny(t, ["yeu", "thich", "thuong", "love", "cute", "de thuong"]),
    emojis: ["❤️", "🥰", "😍", "😘", "💕"],
  },
  {
    // Surprise / wow ("oi" removed: it also matches the vocative "ơi"
    // and the inside of "rồi"/"mọi")
    test: (t) => hasAny(t, ["wow", "that", "kinh", "ghe", "khong tin"]),
    emojis: ["😮", "🤯", "😲", "😳", "😱"],
  },
  {
    // Frustrated / angry -> supportive, don't escalate
    test: (t) => hasAny(t, ["dm", "dit", "tuc", "gian", "buc", "kho chiu", "buc minh", "dien"]),
    emojis: ["😤", "🤗", "😅", "🫂", "💪"],
  },
  {
    // Agreement / ok
    test: (t) => hasAny(t, ["ok", "oke", "duoc", "u", "uh", "um", "dung", "chuan"]),
    emojis: ["👍", "👌", "✅", "🙌", "💯"],
  },
  {
    // Goodbye / sleep ("ngủ ngon" is sleep, not food)
    test: (t) => hasAny(t, ["ngu", "bye", "tam biet", "ngu ngon", "di ngu"]),
    emojis: ["🌙", "👋", "😴", "💤", "🤗"],
  },
  {
    // Food ("ngủ ngon" excluded: it means sleep well, not delicious)
    test: (t) => hasAny(t, ["an", "doi", "ngon", "them"]) && !hasPhrase(t, "ngu ngon"),
    emojis: ["😋", "🤤", "🍜", "😄"],
  },
  {
    // Good news / win / celebration
    test: (t) => hasAny(t, ["tuyet", "gioi", "xong", "dau", "thang", "xin", "dinh"]),
    emojis: ["🎉", "🔥", "👏", "🥳", "💯"],
  },
];

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Emojis found in the message text (so the bot can mirror the sender). */
function extractEmojis(text: string): string[] {
  const found: string[] = [];
  // Match emoji presentation characters (covers the common reaction emojis).
  const re = /\p{Extended_Pictographic}/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    found.push(m[0]);
  }
  return found;
}

/**
 * Pick a reaction for a message. `fallback` is the configured default emoji
 * (used as one option in the fallback pool, not a fixed answer).
 */
export function pickReaction(messageText: string, fallback: string): string {
  const raw = (messageText || "").trim();
  if (!raw) return pickRandom(DEFAULT_POOL);

  const text = normalizeForMatch(raw);

  // 1. Mirror an emoji the sender used (most natural fit) — most of the time.
  const used = extractEmojis(raw);
  if (used.length > 0 && Math.random() < 0.7) {
    return pickRandom(used);
  }

  // 2. Small chance of a surprise pick from the whole pool (spontaneity).
  if (Math.random() < 0.1) {
    return pickRandom(DEFAULT_POOL);
  }

  // 3. Match a category, then randomise inside it (variety, not a template).
  const matched = CATEGORIES.filter((c) => c.test(text));
  if (matched.length > 0) {
    const category = pickRandom(matched);
    return pickRandom(category.emojis);
  }

  // 4. Fallback: the configured emoji is one option among many, not the answer.
  const pool = fallback && !DEFAULT_POOL.includes(fallback) ? [...DEFAULT_POOL, fallback] : DEFAULT_POOL;
  return pickRandom(pool);
}

/** Whether an emoji is a standard Facebook reaction (no custom-reaction flag needed). */
export function isStandardReaction(emoji: string): boolean {
  return STANDARD_REACTIONS.includes(emoji);
}
