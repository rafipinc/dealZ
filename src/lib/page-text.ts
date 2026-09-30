// Visible text of a retailer page, and the part of it worth sending to a
// language model. Pure string work; the llm_extract source (ADR-0013) uses it
// to keep the prompt small without losing the fragments that carry prices.

/** Named entities retailers commonly emit. Numeric entities are decoded generically. */
const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ["nbsp", " "],
  ["amp", "&"],
  ["quot", '"'],
  ["apos", "'"],
  ["lt", "<"],
  ["gt", ">"],
  ["copy", "©"],
  ["reg", "®"],
  ["trade", "™"],
  ["hellip", "…"],
  ["ndash", "–"],
  ["mdash", "—"],
  ["lsquo", "‘"],
  ["rsquo", "’"],
  ["ldquo", "“"],
  ["rdquo", "”"],
  ["pound", "£"],
  ["euro", "€"],
  ["yen", "¥"],
]);

/** One pass over every entity, so "&amp;#36;" decodes to "&#36;" and not to "$". */
const ENTITY_RE = /&(#x[0-9a-f]+|#[0-9]+|[a-z]+[0-9]*);/gi;

function decodeEntity(entity: string, body: string): string {
  const lower = body.toLowerCase();
  if (lower.startsWith("#x")) {
    const code = Number.parseInt(lower.slice(2), 16);
    return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
  }
  if (lower.startsWith("#")) {
    const code = Number.parseInt(lower.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
  }
  return NAMED_ENTITIES.get(lower) ?? entity;
}

/** Decodes the common named entities and every decimal or hex numeric entity. */
export function decodeEntities(text: string): string {
  return text.replace(ENTITY_RE, decodeEntity);
}

/**
 * The text a visitor would read: scripts, styles, noscript blocks, comments
 * and tags are dropped, entities decoded and whitespace collapsed to single
 * spaces. Tags become a space so "<span>$</span>4,158" reads "$ 4,158" and
 * not "$4,158"; callers compare after whitespace normalisation.
 */
export function visibleText(html: string): string {
  const withoutBlocks = html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(withoutBlocks).replace(/\s+/g, " ").trim();
}

export interface TrimAroundPricesOptions {
  /** Characters kept from the start of the text, where the title usually is. */
  headChars?: number;
  /** Characters kept on each side of a currency symbol. */
  window?: number;
  /** Upper bound on the result's length. */
  cap?: number;
  /** Strings that mark a price: "$" by default. "AUD" catches "AUD 4,158.00". */
  currencySymbols?: string[];
}

export const TRIM_DEFAULTS: Required<TrimAroundPricesOptions> = {
  headChars: 2500,
  window: 250,
  cap: 14000,
  currencySymbols: ["$"],
};

/** The separator between kept spans. */
export const TRIM_SEPARATOR = "\n...\n";

type Span = { start: number; end: number };

/** Every index at which one of the symbols occurs, in ascending order. */
function symbolIndices(text: string, symbols: string[]): number[] {
  const indices: number[] = [];
  for (const symbol of symbols) {
    if (symbol.length === 0) continue;
    let at = text.indexOf(symbol);
    while (at !== -1) {
      indices.push(at);
      at = text.indexOf(symbol, at + symbol.length);
    }
  }
  return indices.sort((a, b) => a - b);
}

/** Sorted spans folded so that no character is kept twice. */
function mergeSpans(spans: Span[]): Span[] {
  const merged: Span[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

/**
 * Keeps the head of the text plus a window around every currency symbol,
 * with overlapping windows merged so nothing is sent twice, joined with
 * TRIM_SEPARATOR and cut at `cap`. A page's price fragments survive even when
 * the prompt budget does not allow the whole page.
 */
export function trimAroundPrices(text: string, options: TrimAroundPricesOptions = {}): string {
  const { headChars, window, cap, currencySymbols } = { ...TRIM_DEFAULTS, ...options };
  const spans: Span[] = [{ start: 0, end: Math.min(text.length, headChars) }];
  for (const index of symbolIndices(text, currencySymbols)) {
    spans.push({ start: Math.max(0, index - window), end: Math.min(text.length, index + window) });
  }
  spans.sort((a, b) => a.start - b.start);
  const joined = mergeSpans(spans)
    .filter((span) => span.end > span.start)
    .map((span) => text.slice(span.start, span.end))
    .join(TRIM_SEPARATOR);
  return joined.length > cap ? joined.slice(0, cap) : joined;
}
