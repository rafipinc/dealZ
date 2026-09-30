import { describe, expect, it } from "vitest";
import { TRACKING_PARAMS, canonicaliseUrl, isTrackingParam } from "./url";

describe("isTrackingParam", () => {
  it.each([
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
  ])("treats %s as tracking", (name) => {
    expect(TRACKING_PARAMS.has(name)).toBe(true);
    expect(isTrackingParam(name)).toBe(true);
  });

  it.each(["utm_source", "utm_medium", "UTM_Campaign", "utm_x"])(
    "treats %s as tracking because it starts with utm_",
    (name) => {
      expect(isTrackingParam(name)).toBe(true);
    },
  );

  it("matches known names case-insensitively", () => {
    expect(isTrackingParam("GCLID")).toBe(true);
    expect(isTrackingParam("FbClId")).toBe(true);
  });

  it.each(["page", "variant", "sku", "utm", "referrer"])("keeps %s", (name) => {
    expect(isTrackingParam(name)).toBe(false);
  });
});

describe("canonicaliseUrl", () => {
  it("lowercases the host", () => {
    expect(canonicaliseUrl("https://WWW.JBHIFI.com.au/products/x")).toBe(
      "https://www.jbhifi.com.au/products/x",
    );
  });

  it("drops the fragment", () => {
    expect(canonicaliseUrl("https://example.com/p/1#reviews")).toBe("https://example.com/p/1");
  });

  it("drops a default port", () => {
    expect(canonicaliseUrl("https://example.com:443/p/1")).toBe("https://example.com/p/1");
    expect(canonicaliseUrl("http://example.com:80/p/1")).toBe("http://example.com/p/1");
  });

  it("keeps a non-default port", () => {
    expect(canonicaliseUrl("http://localhost:3000/p/1")).toBe("http://localhost:3000/p/1");
  });

  it("removes tracking parameters and leaves no ? when none remain", () => {
    expect(
      canonicaliseUrl(
        "https://www.jbhifi.com.au/products/x?utm_source=google&gclid=abc&UTM_Medium=cpc&fbclid=1",
      ),
    ).toBe("https://www.jbhifi.com.au/products/x");
  });

  it("sorts the remaining parameters by key", () => {
    expect(canonicaliseUrl("https://example.com/p?z=1&a=2&m=3&utm_campaign=x")).toBe(
      "https://example.com/p?a=2&m=3&z=1",
    );
  });

  it("keeps repeated keys in their original order", () => {
    expect(canonicaliseUrl("https://example.com/p?b=2&a=second&a=first")).toBe(
      "https://example.com/p?a=second&a=first&b=2",
    );
  });

  it("preserves a trailing slash on the path", () => {
    expect(canonicaliseUrl("https://www.samsung.com/au/tvs/oled-tv/x/")).toBe(
      "https://www.samsung.com/au/tvs/oled-tv/x/",
    );
  });

  it("does not add a trailing slash to a path", () => {
    expect(canonicaliseUrl("https://www.thegoodguys.com.au/samsung-65-s85h")).toBe(
      "https://www.thegoodguys.com.au/samsung-65-s85h",
    );
  });

  it("keeps an empty query out of the result", () => {
    expect(canonicaliseUrl("https://example.com/p?")).toBe("https://example.com/p");
  });

  it("throws a TypeError for a relative URL", () => {
    expect(() => canonicaliseUrl("/products/x")).toThrow(TypeError);
  });

  it("throws a TypeError for an empty string", () => {
    expect(() => canonicaliseUrl("")).toThrow(TypeError);
  });

  it.each(["mailto:deals@example.com", "ftp://example.com/file", "javascript:alert(1)"])(
    "throws a TypeError for the non-http URL %s",
    (input) => {
      expect(() => canonicaliseUrl(input)).toThrow(TypeError);
    },
  );
});
