import { describe, expect, it } from "vitest";
import { slugify } from "./slug";

describe("slugify", () => {
  it.each([
    ["JB Hi-Fi", "jb-hi-fi"],
    ["The Good Guys", "the-good-guys"],
    ["Amazon.com.au", "amazon-com-au"],
    ["Bing Lee ", "bing-lee"],
    ["Harvey Norman", "harvey-norman"],
    ["eBay - jbhifi_official", "ebay-jbhifi-official"],
  ])("turns %j into %j", (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it("replaces an ampersand with and", () => {
    expect(slugify("B&H Photo")).toBe("b-and-h-photo");
    expect(slugify("Bed & Bath")).toBe("bed-and-bath");
  });

  it("strips diacritics", () => {
    expect(slugify("Café Électronique")).toBe("cafe-electronique");
    expect(slugify("Müller")).toBe("muller");
  });

  it("collapses runs of separators and trims leading and trailing hyphens", () => {
    expect(slugify("  --Officeworks!!  (Online)--  ")).toBe("officeworks-online");
  });

  it("keeps digits", () => {
    expect(slugify("Store 2 Go")).toBe("store-2-go");
  });

  it("returns an empty string when there are no letters or digits", () => {
    expect(slugify("")).toBe("");
    expect(slugify("---")).toBe("");
    expect(slugify("!!! ???")).toBe("");
  });
});
