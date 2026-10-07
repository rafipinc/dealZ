import { describe, expect, it } from "vitest";
import { routeQuery } from "./query-routing";

describe("routeQuery", () => {
  it("routes 8 to 14 digits with a valid check digit as a GTIN, in 14-digit form", () => {
    expect(routeQuery("8806097962670")).toEqual({ queryKind: "gtin", gtin: "08806097962670" });
    expect(routeQuery("96385074")).toEqual({ queryKind: "gtin", gtin: "00000096385074" });
    expect(routeQuery("08806097962670")).toEqual({ queryKind: "gtin", gtin: "08806097962670" });
  });

  it("routes a digit string with a bad check digit as text", () => {
    expect(routeQuery("8806097962671")).toEqual({ queryKind: "text", gtin: null });
  });

  it("routes a digit string of another length as text", () => {
    expect(routeQuery("1234567")).toEqual({ queryKind: "text", gtin: null });
    expect(routeQuery("123456789012345")).toEqual({ queryKind: "text", gtin: null });
  });

  it("routes a GTIN with spaces or hyphens as text, since the stores index the bare digits", () => {
    expect(routeQuery("880 6097 962670")).toEqual({ queryKind: "text", gtin: null });
    expect(routeQuery("8806097-962670")).toEqual({ queryKind: "text", gtin: null });
  });

  it("routes words and model codes as text", () => {
    expect(routeQuery("LG C5 65")).toEqual({ queryKind: "text", gtin: null });
    expect(routeQuery("QA65S85HAEXXY")).toEqual({ queryKind: "text", gtin: null });
    expect(routeQuery("")).toEqual({ queryKind: "text", gtin: null });
  });
});
