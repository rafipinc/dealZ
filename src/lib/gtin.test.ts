import { describe, expect, it } from "vitest";
import { isValidGtin, normaliseGtin } from "./gtin";

describe("normaliseGtin", () => {
  it.each([
    ["a GTIN-13", "8806097962670", "08806097962670"],
    ["a GTIN-14", "08806097962670", "08806097962670"],
    ["a GTIN-12 (UPC-A)", "036000291452", "00036000291452"],
    ["a GTIN-8", "96385074", "00000096385074"],
    ["a GTIN with whitespace", " 8806 0979 62670 ", "08806097962670"],
    ["a GTIN with hyphens", "880-6097-962670", "08806097962670"],
  ])("normalises %s to 14 digits", (_label, input, expected) => {
    expect(normaliseGtin(input)).toBe(expected);
  });

  it.each([
    ["an empty string", ""],
    ["whitespace only", "   "],
    ["a bad check digit", "8806097962671"],
    ["a bad check digit on a GTIN-8", "96385075"],
    ["non-digit characters", "8806O97962670"],
    ["a decimal", "8806097962.670"],
    ["an unsupported length (10 digits)", "8806097962"],
    ["an unsupported length (7 digits)", "9638507"],
    ["too many digits", "008806097962670"],
  ])("returns null for %s", (_label, input) => {
    expect(normaliseGtin(input)).toBeNull();
  });
});

describe("isValidGtin", () => {
  it("is true for a GTIN with a valid check digit", () => {
    expect(isValidGtin("8806097962670")).toBe(true);
  });

  it("is false for a GTIN with a bad check digit", () => {
    expect(isValidGtin("8806097962671")).toBe(false);
  });
});
