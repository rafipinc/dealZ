import { describe, expect, it } from "vitest";
import { isModelCode, normaliseModelCode, readModelCode } from "./model-code";

describe("isModelCode", () => {
  it.each(["QA65S85HAEXXY", "OLED65B6PSA", "65QNED70BSA", "65C7L", "AB12CD"])(
    "accepts %s",
    (token) => {
      expect(isModelCode(token)).toBe(true);
    },
  );

  it.each([
    ["a pure number", "8806097962670"],
    ["a plain word", "SAMSUNG"],
    ["one digit only", "OLED6X"],
    ["one letter only", "123456A"],
    ["a lower-case code", "qa65s85haexxy"],
    ["a mixed-case word", "Smart65"],
    ["a token under five characters", "S85H"],
    ["a token over twenty characters", "A1B2C3D4E5F6G7H8I9J0K"],
    ["an empty string", ""],
  ])("rejects %s", (_label, token) => {
    expect(isModelCode(token)).toBe(false);
  });

  it.each(["HDR10PLUS", "USB32", "HDMI21", "WIFI6E", "DOLBY51", "ATMOS71"])(
    "rejects the spec token %s by the deny list",
    (token) => {
      expect(isModelCode(token)).toBe(false);
    },
  );

  it("still accepts a code that merely contains a spec word", () => {
    expect(isModelCode("XHDMI21")).toBe(true);
    expect(isModelCode("USBC2024")).toBe(true);
  });

  it("accepts a series label such as QNED70B, a known false positive", () => {
    expect(isModelCode("QNED70B")).toBe(true);
  });

  it("accepts a spec token off the deny list such as BT52, a known false positive", () => {
    expect(isModelCode("BT52X")).toBe(true);
  });

  it.each(["XR-65A95L", "KD-55X80L", "KDL-55W800C", "HW-Q990H"])(
    "accepts the hyphenated form %s: a short letter prefix, then a code on its own",
    (token) => {
      expect(isModelCode(token)).toBe(true);
    },
  );

  it("accepts a brand or spec prefix joined to a code, such as LG-OLED65C4, a known false positive", () => {
    expect(isModelCode("LG-OLED65C4")).toBe(true);
    expect(isModelCode("QD-OLED65")).toBe(true);
    expect(isModelCode("USB-C32GEN2")).toBe(true);
    // The joined token no longer matches the plain code another store prints.
    expect(normaliseModelCode("LG-OLED65C4")).not.toBe(normaliseModelCode("OLED65C4"));
  });

  it.each([
    ["a prefix of one letter", "X-65A95L"],
    ["a prefix of five letters", "BRAVO-65A95L"],
    ["a prefix with a digit", "4K-65A95L"],
    ["a left part that is a code, not a prefix", "QA65S85HAEXXY-BLACK"],
    ["a right part that is not a code", "WI-FI"],
    ["a right part that is a year", "XR-2026"],
    ["a date range", "2026-10"],
    ["a spec pair", "4K-UHD"],
    ["two hyphens", "XR-65A95L-AU"],
    ["a lower-case prefix", "xr-65A95L"],
    ["a spec token split by a hyphen", "HDR-10PLUS"],
  ])("rejects a hyphenated token with %s", (_label, token) => {
    expect(isModelCode(token)).toBe(false);
  });
});

describe("normaliseModelCode", () => {
  it.each([
    ["a hyphenated Sony code", "XR-65A95L", "XR65A95L"],
    ["a code without hyphens", "XR65A95L", "XR65A95L"],
    ["a lower-case code with surrounding space", "  xr-65a95l ", "XR65A95L"],
    ["a code with inner spaces", "QA65 S85H AEXXY", "QA65S85HAEXXY"],
    ["a Samsung soundbar code with its region suffix", "HW-Q990H/XY", "HWQ990H/XY"],
  ])("normalises %s", (_label, input, expected) => {
    expect(normaliseModelCode(input)).toBe(expected);
  });

  it.each([
    ["null", null],
    ["an empty string", ""],
    ["whitespace only", "   "],
    ["hyphens only", "--"],
  ])("returns null for %s", (_label, input) => {
    expect(normaliseModelCode(input)).toBeNull();
  });

  it("gives one answer for the two ways stores print a code", () => {
    expect(normaliseModelCode("XR-65A95L")).toBe(normaliseModelCode("XR65A95L"));
  });
});

describe("readModelCode", () => {
  it.each([
    ['LG 65" AI B6 4K Smart OLED TV 2026 OLED65B6PSA', "OLED65B6PSA"],
    ['LG 65" QNED70 4K Smart QNED Mini LED AI TV 65QNED70BSA', "65QNED70BSA"],
    ['Samsung 65" S85H 4K Vision AI OLED Smart TV QA65S85HAEXXY', "QA65S85HAEXXY"],
    ["TCL 65 inch C7L 4K QD-Mini LED TV 65C7L", "65C7L"],
  ])("reads the code at the end of %s", (title, expected) => {
    expect(readModelCode(title)).toBe(expected);
  });

  it("takes the last qualifying token when a title holds more than one", () => {
    expect(readModelCode("QNED70B series: 65QNED70BSA")).toBe("65QNED70BSA");
  });

  it("returns null for a title with no code", () => {
    expect(readModelCode('LG 65" OLED EVO AI C6 4K Smart TV [2026]')).toBeNull();
    expect(readModelCode('Samsung 65" S85H OLED 4K Smart AI TV [2026]')).toBeNull();
  });

  it("returns null for an empty title", () => {
    expect(readModelCode("")).toBeNull();
  });

  it("ignores a code that is part of a longer mixed-case token", () => {
    expect(readModelCode("ModelQA65S85HAEXXY")).toBeNull();
  });

  it("reads a code wrapped in brackets", () => {
    expect(readModelCode("Samsung S85H (QA65S85HAEXXY)")).toBe("QA65S85HAEXXY");
  });

  it("does not take a spec token that follows the code", () => {
    expect(readModelCode("LG 65 OLED65B6PSA HDMI21 HDR10PLUS")).toBe("OLED65B6PSA");
  });

  it("takes a series label that follows the code, a known false positive", () => {
    expect(readModelCode("LG 65 65QNED70BSA QNED70B")).toBe("QNED70B");
  });

  it.each([
    ["Sony 65 inch A95L BRAVIA XR OLED TV XR-65A95L", "XR-65A95L"],
    ['Sony 55" X80L BRAVIA 4K HDR Google TV KD-55X80L', "KD-55X80L"],
    ["Samsung 11.1.4 Channel Q-Series Soundbar & Wireless Subwoofer HW-Q990H/XY", "HW-Q990H"],
  ])("reads a hyphenated code as printed from %s", (title, expected) => {
    expect(readModelCode(title)).toBe(expected);
  });

  it("reads the code out of a hyphenated token whose left part is too long to be a prefix", () => {
    expect(readModelCode("Samsung 65 S85H QA65S85HAEXXY-BLACK")).toBe("QA65S85HAEXXY");
    expect(readModelCode("Samsung 65 S85H BLACK-QA65S85HAEXXY")).toBe("QA65S85HAEXXY");
  });

  it("does not read a hyphenated token that is not a code", () => {
    expect(readModelCode("Sony 65 TV 2026-10 WI-FI 4K-UHD QD-Mini 65-inch")).toBeNull();
  });

  it("reads a hyphenated code that follows a plain one", () => {
    expect(readModelCode("Was OLED65B6PSA now XR-65A95L")).toBe("XR-65A95L");
  });
});
