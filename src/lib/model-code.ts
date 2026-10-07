// Model codes as retailers print them in product titles: "LG 65" AI B6 4K
// Smart OLED TV 2026 OLED65B6PSA". A general rule, not a per-brand one
// (ADR-0016 item 11): a token of 5 to 20 upper-case letters and digits with
// at least two of each. Pure numbers (a year, a GTIN) and plain words are
// rejected. Stores put the code at the end of the title, so the last
// qualifying token wins.
//
// Known false positives, tokens the rule accepts that are not model codes:
// - Series labels such as "QNED70B" or "A95L". They pass as the rule is
//   written; a store that puts one after the code would win over the code.
// - Spec tokens: a feature name followed by a version, "HDR10PLUS", "USB32",
//   "HDMI21", "WIFI6E". A small deny list below rejects the common prefixes
//   (HDMI, USB, HDR, WIFI, DOLBY, ATMOS) when a digit follows them. Any
//   other spec token, "BT52" say, still passes.
//
// Known false negative: hyphenated codes such as Sony's "XR-65A95L" are not
// read. The hyphen splits them and neither half qualifies. Revisit when such
// a store is added.

const MIN_LENGTH = 5;
const MAX_LENGTH = 20;

/** An upper-case alphanumeric run not touching another letter, digit or hyphen. */
const TOKEN_RE = /(?<![A-Za-z0-9-])[A-Z0-9]+(?![A-Za-z0-9-])/g;

/** A feature name that, followed by a version number, is a spec, never a model code. */
const SPEC_PREFIX_RE = /^(?:HDMI|USB|HDR|WIFI|DOLBY|ATMOS)[0-9]/;

function countMatches(token: string, pattern: RegExp): number {
  return (token.match(pattern) ?? []).length;
}

/** True for a token that is a model code by the general rule above. */
export function isModelCode(token: string): boolean {
  if (token.length < MIN_LENGTH || token.length > MAX_LENGTH) return false;
  if (!/^[A-Z0-9]+$/.test(token)) return false;
  if (SPEC_PREFIX_RE.test(token)) return false;
  return countMatches(token, /[A-Z]/g) >= 2 && countMatches(token, /[0-9]/g) >= 2;
}

/**
 * The last model code in a title as the store printed it, or null when no
 * token qualifies.
 */
export function readModelCode(title: string): string | null {
  let last: string | null = null;
  for (const match of title.matchAll(TOKEN_RE)) {
    if (isModelCode(match[0])) last = match[0];
  }
  return last;
}
