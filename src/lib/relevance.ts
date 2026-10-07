// Relevance of a store's search result to the query that produced it.
// Shopify predictive search matches any query word anywhere, description
// included, and a store with nothing to say still answers with ten
// unrelated products (the fixtures of 2026-10-06 in src/sources/fixtures).
// Asking the store to match on title and vendor only changed nothing, so
// the rule is ours: every query word must appear in the title or brand.
//
// Tiers, best first:
// - match: every query word appears and the title is not an accessory.
// - accessory: every query word appears, but the title names the product
//   as something the item is for ("Racing Wheel for XBOX Series X/S") or
//   carries an accessory word the query does not.
// - partial: not every word appears, but a word of three or more
//   characters does, or half the words do.
// - unrelated: nothing of substance matched.
//
// Known false positives, kept for simplicity and honesty. Every query word
// must appear, but in any order and with any gap between them:
// - "Sony Bravia 8" matches "Sony BRAVIA Theatre Sub 8", a soundbar
//   subwoofer, and "Bravia 8 II", a different television. The phrase bonus
//   ranks the contiguous title higher but the tier is the same.
// - "Series X Xbox Console" matches "Xbox Series X 1TB Console": order is
//   never checked.
// - A possessive used to leave a stray token: "Microsoft's" became
//   "microsoft" and "s", and the "s" satisfied the "s" of "Xbox Series S".
//   A trailing 's or ’s is now stripped before tokenising; any other stray
//   one-letter token still counts.
//
// Known false negatives, kept for the same reasons:
// - "for" anywhere before the first query word reads as an accessory, so
//   "Perfect for gamers: Xbox Series X 1TB Console" is an accessory.
// - An accessory word inside a product title reads as an accessory:
//   "with Solar Remote" on a television, "Disc Drive Edition" on a console,
//   "Console with Controller" on a bundle.
// - "Lenovo Legion Go S" shares only "s" with "Xbox Series S" and is
//   unrelated; a one- or two-character word alone never makes a partial.
// - A query that is itself an accessory ("Xbox stand") skips both accessory
//   rules, so "Stand for Xbox" is a match; nothing is "an accessory for"
//   an accessory.

export type RelevanceTier = "match" | "accessory" | "partial" | "unrelated";

export interface Relevance {
  tier: RelevanceTier;
  /** Higher is better; orders rows within a tier. Never below 0. */
  score: number;
  /** Query words found in the title or brand, in query order. */
  matched: string[];
  /** Query words found in neither, in query order. */
  missing: string[];
  /** A short human reason: "every word in the title", "missing: 65". */
  reason: string;
}

/** The order the tiers are shown in, best first. */
export const TIER_ORDER: readonly RelevanceTier[] = ["match", "accessory", "partial", "unrelated"];

/**
 * The tiers kept out of the main list unless asked for: a partial or
 * unrelated row is shown under "Other results", never among the matches.
 */
export const HIDDEN_TIERS: ReadonlySet<RelevanceTier> = new Set(["partial", "unrelated"]);

/** True for a row shown only on request: a partial or unrelated one. */
export function isHiddenByDefault(tier: RelevanceTier): boolean {
  return HIDDEN_TIERS.has(tier);
}

/** Words that name an accessory when the query does not ask for one. */
export const ACCESSORY_WORDS: ReadonlySet<string> = new Set([
  "controller",
  "stand",
  "charger",
  "charging",
  "case",
  "cable",
  "mount",
  "wheel",
  "headset",
  "cover",
  "skin",
  "bracket",
  "remote",
  "adapter",
  "bag",
  "drive",
]);

/** A query word this short never makes a partial match on its own. */
const SHORT_WORD = 3;
const PHRASE_BONUS = 3;
const MATCHED_BONUS = 1;
const EXTRA_WORD_PENALTY = 0.1;

/** A possessive ending, straight or curly, at the end of a word: "Microsoft's", "Sony’s". */
const POSSESSIVE = /['’]s(?![\p{L}\p{N}])/gu;

/** The words of a text in order, duplicates kept: lower-case runs of letters and digits. */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(POSSESSIVE, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "");
}

/** The distinct words of a text, in first-seen order. */
export function tokenise(text: string): string[] {
  return Array.from(new Set(words(text)));
}

/** True when `needle` occurs in `haystack` as a contiguous run, in order. */
function containsPhrase(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    if (needle.every((word, offset) => haystack[start + offset] === word)) return true;
  }
  return false;
}

/** The accessory rule that fires for this title, or null when neither does. */
function accessoryReason(titleWords: string[], queryTokens: string[]): string | null {
  if (queryTokens.some((token) => ACCESSORY_WORDS.has(token))) return null;
  // The first query word the title carries; "for" anywhere before it names the product as a target.
  const named = titleWords.findIndex((word) => queryTokens.includes(word));
  if (named !== -1 && titleWords.slice(0, named).includes("for")) {
    return 'accessory for the product ("for" before the name)';
  }
  const accessoryWord = titleWords.find((word) => ACCESSORY_WORDS.has(word));
  return accessoryWord === undefined
    ? null
    : `accessory for the product ("${accessoryWord}" in the title)`;
}

function roundToTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

function scoreOf(titleWords: string[], queryTokens: string[], matched: string[]): number {
  const matchedSet = new Set(matched);
  const extraTitleWords = new Set(titleWords.filter((word) => !matchedSet.has(word))).size;
  const phrase = containsPhrase(titleWords, queryTokens) ? PHRASE_BONUS : 0;
  const score = phrase + matched.length * MATCHED_BONUS - extraTitleWords * EXTRA_WORD_PENALTY;
  return Math.max(0, roundToTenth(score));
}

/** True when what matched is enough for a partial: one real word, or half the query. */
function isPartial(queryTokens: string[], matched: string[]): boolean {
  if (matched.some((token) => token.length >= SHORT_WORD)) return true;
  return queryTokens.length >= 2 && matched.length * 2 >= queryTokens.length;
}

/**
 * How well one store result answers the query. Every query word is
 * required; the brand counts as part of the candidate's text, the title
 * alone decides the accessory rule and the score.
 */
export function judgeRelevance(
  query: string,
  candidate: { title: string; brand: string | null },
): Relevance {
  const queryTokens = tokenise(query);
  const titleWords = words(candidate.title);
  const candidateTokens = new Set(tokenise(`${candidate.title} ${candidate.brand ?? ""}`));
  const matched = queryTokens.filter((token) => candidateTokens.has(token));
  const missing = queryTokens.filter((token) => !candidateTokens.has(token));
  const score = scoreOf(titleWords, queryTokens, matched);

  if (queryTokens.length > 0 && missing.length === 0) {
    const accessory = accessoryReason(titleWords, queryTokens);
    if (accessory !== null) {
      return { tier: "accessory", score, matched, missing, reason: accessory };
    }
    return { tier: "match", score, matched, missing, reason: "every word in the title" };
  }
  if (isPartial(queryTokens, matched)) {
    return { tier: "partial", score, matched, missing, reason: `missing: ${missing.join(", ")}` };
  }
  const reason =
    matched.length === 0 ? "no query word in the title" : `missing: ${missing.join(", ")}`;
  return { tier: "unrelated", score, matched, missing, reason };
}

/** What compareByRelevance orders by. The retailer name breaks a tie between stores listing one title. */
export interface RelevanceSortKey {
  relevance: Relevance;
  title: string;
  retailerName?: string;
}

/**
 * Best tier first, then the higher score, then the title, then the retailer
 * name, so the order is stable across runs and the same wherever rows are
 * shown. Comparisons use the "en" collation whatever the host's locale.
 */
export function compareByRelevance(a: RelevanceSortKey, b: RelevanceSortKey): number {
  const byTier = TIER_ORDER.indexOf(a.relevance.tier) - TIER_ORDER.indexOf(b.relevance.tier);
  if (byTier !== 0) return byTier;
  const byScore = b.relevance.score - a.relevance.score;
  if (byScore !== 0) return byScore;
  const byTitle = a.title.localeCompare(b.title, "en");
  if (byTitle !== 0) return byTitle;
  return (a.retailerName ?? "").localeCompare(b.retailerName ?? "", "en");
}
