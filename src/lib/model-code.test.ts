import { describe, expect, it } from "vitest";
import { isModelCode, readModelCode } from "./model-code";

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

  it("rejects a hyphenated code such as XR-65A95L, a known false negative", () => {
    expect(isModelCode("XR-65A95L")).toBe(false);
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

  it("returns null for a title whose only candidate is a hyphenated code, a known false negative", () => {
    expect(readModelCode("Sony 65 inch A95L BRAVIA XR OLED TV XR-65A95L")).toBeNull();
  });
});
