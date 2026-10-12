import { describe, expect, it } from "vitest";
import { normaliseBrand } from "./brand";

describe("normaliseBrand", () => {
  it.each([
    ["SAMSUNG", "Samsung"],
    ["samsung", "Samsung"],
    ["Samsung", "Samsung"],
    ["lg", "LG"],
    ["Lg", "LG"],
    ["Tcl", "TCL"],
    ["jbl", "JBL"],
    ["asus", "ASUS"],
    ["chiq", "CHiQ"],
    ["gopro", "GoPro"],
    ["playstation", "PlayStation"],
    ["de'longhi", "De'Longhi"],
    ["FISHER & PAYKEL", "Fisher & Paykel"],
  ])("gives %s its canonical casing %s", (input, expected) => {
    expect(normaliseBrand(input)).toBe(expected);
  });

  it.each([
    ["MOZA RACING", "Moza Racing"],
    ["yokohama", "Yokohama"],
    ["SONY COMP", "Sony Comp"],
    ["blaupunkt", "Blaupunkt"],
    ["POWER A", "Power A"],
  ])("title-cases an unknown brand %s as %s", (input, expected) => {
    expect(normaliseBrand(input)).toBe(expected);
  });

  it("trims and collapses whitespace before looking the brand up", () => {
    expect(normaliseBrand("  samsung  ")).toBe("Samsung");
    expect(normaliseBrand("fisher   &\tpaykel")).toBe("Fisher & Paykel");
    expect(normaliseBrand("moza \n racing")).toBe("Moza Racing");
  });

  it("returns an empty string for an empty or blank input", () => {
    expect(normaliseBrand("")).toBe("");
    expect(normaliseBrand("   ")).toBe("");
  });

  it("does not fold a spelling variant, only casing", () => {
    expect(normaliseBrand("DELONGHI")).toBe("Delonghi");
    expect(normaliseBrand("fisher and paykel")).toBe("Fisher And Paykel");
  });
});
