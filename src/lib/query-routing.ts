// Query routing for catalogue discovery (ADR-0016 item 7): 8 to 14 digits
// with a valid check digit is a GTIN, reported in its 14-digit form.
// Anything else, including a digit string whose check digit fails, is text.
// Pure: the service that searches the stores decides what to do with the kind.

import { normaliseGtin } from "./gtin";

export type QueryKind = "gtin" | "text";

export interface RoutedQuery {
  queryKind: QueryKind;
  /** The 14-digit form when the query is a GTIN; null for text. */
  gtin: string | null;
}

const GTIN_QUERY_RE = /^[0-9]{8,14}$/;

/** The routing rule of ADR-0016 item 7. A digit string whose check digit fails is text. */
export function routeQuery(query: string): RoutedQuery {
  if (!GTIN_QUERY_RE.test(query)) return { queryKind: "text", gtin: null };
  const gtin = normaliseGtin(query);
  return gtin === null ? { queryKind: "text", gtin: null } : { queryKind: "gtin", gtin };
}
