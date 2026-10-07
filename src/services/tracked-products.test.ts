// matchTrackedVariant: the one answer to "is this product already held?",
// shared by discovery and the catalogue index. Trust order is GTIN, then
// model code, then page URL (ADR-0004).

import { describe, expect, it } from "vitest";
import { canonicaliseUrl } from "@/lib/url";
import { ValidationError } from "./errors";
import { matchTrackedVariant, trackedVariants, type Identified } from "./tracked-products";

const S85H = trackedVariants[0];
const JB_PAGE = "https://www.jbhifi.com.au/products/samsung-65-s85h-oled-4k-smart-ai-tv-2026";
const UNRELATED_PAGE = "https://powerland.com.au/products/lg-65-c5";

function found(
  overrides: Partial<Identified["identifiers"]> = {},
  url = UNRELATED_PAGE,
): Identified {
  return { url, identifiers: { gtin: null, mpn: null, retailerSku: null, ...overrides } };
}

describe("matchTrackedVariant", () => {
  it("matches a product by its 14-digit GTIN", () => {
    expect(matchTrackedVariant(found({ gtin: S85H.gtin }))).toEqual({
      trackedVariantSlug: S85H.slug,
      matchedBy: "gtin",
    });
  });

  it("matches a product by its MPN, ignoring case and surrounding space", () => {
    expect(matchTrackedVariant(found({ mpn: ` ${S85H.mpn.toLowerCase()} ` }))).toEqual({
      trackedVariantSlug: S85H.slug,
      matchedBy: "mpn",
    });
  });

  it("matches a product by a retailer SKU that is the model code", () => {
    expect(matchTrackedVariant(found({ retailerSku: S85H.mpn }))).toEqual({
      trackedVariantSlug: S85H.slug,
      matchedBy: "mpn",
    });
  });

  it("matches a product by a tracked page URL in its canonical form", () => {
    expect(matchTrackedVariant(found({}, canonicaliseUrl(JB_PAGE)))).toEqual({
      trackedVariantSlug: S85H.slug,
      matchedBy: "url",
    });
  });

  it("prefers the GTIN when the GTIN, model code and URL all match", () => {
    const all = found({ gtin: S85H.gtin, mpn: S85H.mpn }, canonicaliseUrl(JB_PAGE));
    expect(matchTrackedVariant(all).matchedBy).toBe("gtin");
  });

  it("prefers the model code over the URL", () => {
    expect(matchTrackedVariant(found({ mpn: S85H.mpn }, canonicaliseUrl(JB_PAGE))).matchedBy).toBe(
      "mpn",
    );
  });

  it("answers null for a product the tracked table does not hold", () => {
    expect(
      matchTrackedVariant(
        found({ gtin: "08806097000000", mpn: "OLED65C5PSA", retailerSku: "123" }),
      ),
    ).toEqual({ trackedVariantSlug: null, matchedBy: null });
  });

  it("answers null for a product with no identifiers on an unknown page", () => {
    expect(matchTrackedVariant(found())).toEqual({ trackedVariantSlug: null, matchedBy: null });
  });

  it("does not match a blank model code", () => {
    expect(matchTrackedVariant(found({ mpn: "", retailerSku: "  " })).matchedBy).toBeNull();
  });

  it("throws ValidationError for a product without identifiers", () => {
    const malformed = { url: JB_PAGE } as unknown as Identified;
    expect(() => matchTrackedVariant(malformed)).toThrow(ValidationError);
    expect(() => matchTrackedVariant(malformed)).toThrow("Invalid matchTrackedVariant input");
  });

  it("throws ValidationError for a URL that is not a string", () => {
    const malformed = { url: null, identifiers: found().identifiers } as unknown as Identified;
    expect(() => matchTrackedVariant(malformed)).toThrow(ValidationError);
  });
});
