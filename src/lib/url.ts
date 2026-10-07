// URL canonicalisation for listing pages. Two URLs that point at the same
// retailer page canonicalise to the same string, so the listing uniqueness
// check in the database holds.

export const TRACKING_PARAMS: ReadonlySet<string> = new Set([
  "gclid",
  "gad_source",
  "gad_campaignid",
  "gbraid",
  "wbraid",
  "dclid",
  "fbclid",
  "msclkid",
  "ttclid",
  "twclid",
  "yclid",
  "srsltid",
  "mc_cid",
  "mc_eid",
  "_ga",
  "_gl",
  "ref",
  "igshid",
  // Shopify predictive search appends these to a result's product URL: the
  // result's position, the query and a search id. Never part of the page.
  "_pos",
  "_psq",
  "_psid",
  "_ss",
]);

/** True for a known tracking parameter or any `utm_*` parameter, case-insensitively. */
export function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith("utm_") || TRACKING_PARAMS.has(lower);
}

function compareKeys(a: [string, string], b: [string, string]): number {
  if (a[0] < b[0]) return -1;
  if (a[0] > b[0]) return 1;
  return 0;
}

/**
 * Parses an absolute http or https URL and returns it with the host
 * lowercased, the fragment and default port dropped, tracking parameters
 * removed and the remaining parameters sorted by key. The path is kept as is.
 * Throws a TypeError for anything that is not an absolute http(s) URL.
 */
export function canonicaliseUrl(input: string): string {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(`Unsupported protocol: ${url.protocol}`);
  }
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  const kept = Array.from(url.searchParams.entries())
    .filter(([name]) => !isTrackingParam(name))
    .sort(compareKeys);
  url.search = new URLSearchParams(kept).toString();
  return url.toString();
}
