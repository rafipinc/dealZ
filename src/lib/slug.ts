// Slugs for names that arrive as free text, such as a seller name from an
// aggregator. "JB Hi-Fi" becomes "jb-hi-fi" so it can be compared with the
// tracked retailer slug without a lookup table.

/**
 * Lower-case ASCII letters and digits separated by single hyphens. Diacritics
 * are stripped, "&" becomes "and", everything else becomes a separator.
 * Returns "" when the input has no letters or digits.
 */
export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/&/g, " and ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
