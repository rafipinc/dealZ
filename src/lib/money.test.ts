import { describe, expect, it } from "vitest";
import { formatAud, formatSignedAud, formatVsCheapest, formatVsRrp, parseCents } from "./money";

describe("parseCents", () => {
  it.each([
    ["an integer number", 2795, 279500],
    ["a fractional number", 2795.5, 279550],
    ["a number with two decimals", 27.99, 2799],
    ["zero", 0, 0],
    ["a plain integer string", "2795", 279500],
    ["a string with decimals", "2795.00", 279500],
    ["a string with a thousands separator", "2,795.00", 279500],
    ["a string with a dollar sign", "$2,795.00", 279500],
    ["a string with a currency code", "AUD 2,795.00", 279500],
    ["a string with surrounding whitespace", " 2799 ", 279900],
    ["a string with a fractional cent", "1.005", 100],
    ["a string with half a cent", "1.995", 200],
  ])("parses %s", (_label, input, expected) => {
    expect(parseCents(input)).toBe(expected);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an empty string", ""],
    ["whitespace", "   "],
    ["a string with no digits", "$ AUD"],
    ["a string with two decimal points", "1.2.3"],
    ["a negative string", "-5.00"],
    ["a negative number", -1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("returns null for %s", (_label, input) => {
    expect(parseCents(input)).toBeNull();
  });
});

describe("formatAud", () => {
  it.each([
    [279500, "$2,795.00"],
    [123456789, "$1,234,567.89"],
    [100000, "$1,000.00"],
    [99999, "$999.99"],
    [5, "$0.05"],
    [0, "$0.00"],
    [-100, "-$1.00"],
    [-279500, "-$2,795.00"],
  ])("formats %d cents as %s", (cents, expected) => {
    expect(formatAud(cents)).toBe(expected);
  });

  it("rounds non-integer cents before formatting", () => {
    expect(formatAud(100.4)).toBe("$1.00");
  });
});

describe("formatSignedAud", () => {
  it("prefixes a positive delta with a plus", () => {
    expect(formatSignedAud(40000)).toBe("+$400.00");
  });
  it("leaves zero and negative deltas to formatAud", () => {
    expect(formatSignedAud(0)).toBe("$0.00");
    expect(formatSignedAud(-50400)).toBe("-$504.00");
  });
});

describe("formatVsCheapest", () => {
  it("says cheapest for a zero delta", () => {
    expect(formatVsCheapest(0)).toBe("cheapest");
  });
  it("shows the signed amount otherwise", () => {
    expect(formatVsCheapest(400)).toBe("+$4.00");
  });
});

describe("formatVsRrp", () => {
  it("reports a price under RRP with a rounded percentage", () => {
    expect(formatVsRrp(-50400, 329900)).toBe("-$504.00 (15% under RRP)");
  });
  it("reports a price over RRP", () => {
    expect(formatVsRrp(10000, 329900)).toBe("+$100.00 (3% over RRP)");
  });
  it("reports at RRP for a zero delta", () => {
    expect(formatVsRrp(0, 329900)).toBe("$0.00 (at RRP)");
  });
  it("does not divide by a zero or negative RRP", () => {
    expect(formatVsRrp(-100, 0)).toBe("-$1.00 (at RRP)");
  });
});
