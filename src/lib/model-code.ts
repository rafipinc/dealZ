// Model codes as retailers print them in product titles: "LG 65" AI B6 4K
// Smart OLED TV 2026 OLED65B6PSA". A general rule, not a per-brand one
// (ADR-0016 item 11): a token of 5 to 20 upper-case letters and digits with
// at least two of each. Pure numbers (a year, a GTIN) and plain words are
// rejected. Stores put the code at the end of the title, so the last
// qualifying token wins.
//
// Hyphenated codes, Sony's "XR-65A95L" or Samsung's "HW-Q990H", are read in
// one narrow form only: 2 to 4 upper-case letters, one hyphen, then a run
// that is a code on its own by the rule above. Such a code is returned as
// printed, hyphen included; normaliseModelCode gives the form to compare
// across stores that print it with and without the hyphen. Any other
// hyphenated token is split at its hyphens and each part judged alone, so
// "QA65S85HAEXXY-BLACK" reads as "QA65S85HAEXXY" (the left part is too
// long to be a prefix) and "2026-10", "WI-FI" and "4K-UHD" read as nothing.
//
// Known false positives, tokens the rule accepts that are not model codes:
// - Series labels such as "QNED70B". They pass as the rule is written; a
//   store that puts one after the code would win over the code.
// - Spec tokens: a feature name followed by a version, "HDR10PLUS", "USB32",
//   "HDMI21", "WIFI6E". A small deny list below rejects the common prefixes
//   (HDMI, USB, HDR, WIFI, DOLBY, ATMOS) when a digit follows them, with or
//   without a hyphen between. Any other spec token, "BT52" say, still passes.
// - A brand or spec prefix joined to a code by a hyphen: "LG-OLED65C4",
//   "QD-OLED65", "USB-C32GEN2". The prefix is 2 to 4 letters and the rest
//   is a code alone, so the hyphenated form takes the whole token as the
//   code. Normalised, "LGOLED65C4" no longer matches "OLED65C4" printed at
//   another store, so the two rows do not group.
//
// Known false negative: a hyphenated code outside the narrow form, one with
// a second hyphen before a suffix say, reads as whichever of its parts is a
// code alone, or as nothing. No store seen so far prints one.

const MIN_LENGTH = 5;
const MAX_LENGTH = 20;

/** A printed token: a run of letters, digits and hyphens not touching another of them. */
const PRINTED_TOKEN_RE = /(?<![A-Za-z0-9-])[A-Za-z0-9-]+(?![A-Za-z0-9-])/g;

/** The hyphenated form: a short upper-case prefix, one hyphen, then one upper-case run. */
const HYPHENATED_RE = /^([A-Z]{2,4})-([A-Z0-9]+)$/;

/** A feature name that, followed by a version number, is a spec, never a model code. */
const SPEC_PREFIX_RE = /^(?:HDMI|USB|HDR|WIFI|DOLBY|ATMOS)[0-9]/;

function countMatches(token: string, pattern: RegExp): number {
  return (token.match(pattern) ?? []).length;
}

/** The rule for one run of upper-case letters and digits. */
function isPlainCode(token: string): boolean {
  if (token.length < MIN_LENGTH || token.length > MAX_LENGTH) return false;
  if (!/^[A-Z0-9]+$/.test(token)) return false;
  if (SPEC_PREFIX_RE.test(token)) return false;
  return countMatches(token, /[A-Z]/g) >= 2 && countMatches(token, /[0-9]/g) >= 2;
}

/** True for a token that is a model code by the general rule above, plain or in the hyphenated form. */
export function isModelCode(token: string): boolean {
  const hyphenated = HYPHENATED_RE.exec(token);
  if (hyphenated === null) return isPlainCode(token);
  const [, prefix, rest] = hyphenated;
  return isPlainCode(rest) && !SPEC_PREFIX_RE.test(prefix + rest);
}

/** The code a printed token carries: itself, else the last of its hyphen-separated parts that is one alone. */
function codeOf(token: string): string | null {
  if (isModelCode(token)) return token;
  let last: string | null = null;
  for (const part of token.split("-")) {
    if (isPlainCode(part)) last = part;
  }
  return last;
}

/**
 * The last model code in a title as the store printed it, or null when no
 * token qualifies.
 */
export function readModelCode(title: string): string | null {
  let last: string | null = null;
  for (const match of title.matchAll(PRINTED_TOKEN_RE)) {
    const code = codeOf(match[0]);
    if (code !== null) last = code;
  }
  return last;
}

/**
 * One form for comparing codes across stores that print "XR-65A95L" and
 * "XR65A95L": trimmed, upper-cased, with every hyphen and space removed.
 * Null for null and for a value with nothing left.
 */
export function normaliseModelCode(value: string | null): string | null {
  if (value === null) return null;
  const code = value.toUpperCase().replace(/[\s-]/g, "");
  return code === "" ? null : code;
}
