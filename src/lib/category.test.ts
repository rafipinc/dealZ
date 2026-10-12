import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CATEGORIES, categoryOf, isCategorySlug, type CategoryInput } from "./category";

interface FixtureProduct {
  title: string;
  type?: string;
  product_type?: string;
  tags?: string[];
}

/**
 * The products of one recorded store answer, in the store's order. A
 * predictive search answer nests them; a collection page lists them.
 */
function fixtureProducts(name: string): CategoryInput[] {
  const body = readFileSync(
    fileURLToPath(new URL(`../sources/fixtures/${name}`, import.meta.url)),
    "utf8",
  );
  const json = JSON.parse(body) as {
    products?: FixtureProduct[];
    resources?: { results: { products: FixtureProduct[] } };
  };
  const products = json.products ?? json.resources?.results.products ?? [];
  return products.map((product) => ({
    title: product.title,
    storeType: product.product_type ?? product.type ?? null,
    tags: product.tags ?? [],
  }));
}

/** Title to category for every product of a fixture. */
function categoriesOf(name: string): Record<string, string | null> {
  return Object.fromEntries(
    fixtureProducts(name).map((product) => [product.title, categoryOf(product)]),
  );
}

function product(title: string, storeType: string | null = null): CategoryInput {
  return { title, storeType };
}

describe("CATEGORIES", () => {
  it("lists fourteen kebab-case slugs, each once, with a name", () => {
    expect(CATEGORIES).toHaveLength(14);
    const slugs = CATEGORIES.map((category) => category.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs.every((slug) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))).toBe(true);
    expect(CATEGORIES.every((category) => category.name.length > 0)).toBe(true);
  });
});

describe("isCategorySlug", () => {
  it("is true for a listed slug and false for anything else", () => {
    expect(isCategorySlug("tv")).toBe(true);
    expect(isCategorySlug("coffee-machine")).toBe(true);
    expect(isCategorySlug("Coffee-Machine")).toBe(false);
    expect(isCategorySlug("tvs")).toBe(false);
    expect(isCategorySlug("")).toBe(false);
  });
});

describe("categoryOf", () => {
  describe("by hint", () => {
    it("takes a hint that is a known slug over the store type and the title", () => {
      const soundbar = product("Samsung Q-Series Soundbar HW-Q990H/XY", "Soundbar");
      expect(categoryOf({ ...soundbar, hint: "tv" })).toBe("tv");
    });

    it("ignores a hint that is not a known slug", () => {
      const soundbar = product("Samsung Q-Series Soundbar HW-Q990H/XY", "Soundbar");
      expect(categoryOf({ ...soundbar, hint: "widgets" })).toBe("soundbar");
      expect(categoryOf({ ...soundbar, hint: "TV" })).toBe("soundbar");
      expect(categoryOf({ ...soundbar, hint: null })).toBe("soundbar");
      expect(categoryOf({ ...soundbar, hint: "" })).toBe("soundbar");
    });
  });

  describe("by store type", () => {
    it.each([
      ["OLED", "tv"],
      ["QLED", "tv"],
      ["4K QNED TV", "tv"],
      ["4K QLED UHD", "tv"],
      ["4K Ultra HD LED", "tv"],
      ["TELEVISION", "tv"],
      ["TV", "tv"],
      ["Soundbar", "soundbar"],
      ["SOUND BAR", "soundbar"],
      ["Vacuum", "vacuum"],
      ["STICK VACUUM", "vacuum"],
      ["Coffee Machine", "coffee-machine"],
      ["Split System", "air-conditioner"],
    ])("maps the store type %s to %s whatever the title says", (storeType, expected) => {
      expect(categoryOf(product("Widget", storeType))).toBe(expected);
    });

    it("matches the label whole, with case and surrounding space ignored", () => {
      expect(categoryOf(product("Widget", "  oled  "))).toBe("tv");
      expect(categoryOf(product("Widget", "OLED panels"))).toBeNull();
    });

    it("maps a label that spans categories to nothing, leaving the title to decide", () => {
      expect(categoryOf(product("Laser Multi-Region DVD Player", "VISUAL"))).toBeNull();
      expect(categoryOf(product('Sony 55" BRAVIA 8 II 4K HDR OLED Google TV', "VISUAL"))).toBe(
        "tv",
      );
      expect(categoryOf(product("Xbox Series X 1TB Console", "GAMES HARDWARE"))).toBe("console");
      expect(categoryOf(product("Lexar SL500 1TB Portable SSD", "IT"))).toBeNull();
    });
  });

  describe("by tag", () => {
    it("reads the televisions tag after the store type and before the title", () => {
      expect(categoryOf({ ...product("Widget", "Accessory"), tags: ["televisions"] })).toBe("tv");
      expect(
        categoryOf({ ...product("Samsung Soundbar", "Subwoofer"), tags: ["Televisions"] }),
      ).toBe("tv");
    });

    it("ignores Shopify brand and stock tags", () => {
      expect(categoryOf({ ...product("Widget", "VISUAL"), tags: ["Brand:Lg", "InStock"] })).toBe(
        null,
      );
      expect(
        categoryOf({ ...product("Widget", "Accessory"), tags: ["AUDIO-1Y", "hifi-and-soundbars"] }),
      ).toBeNull();
    });
  });

  describe("by title", () => {
    it.each([
      ["Samsung 5.1.2 Channel Q-Series Soundbar & Wireless Subwoofer", "soundbar"],
      ["Sony BRAVIA Theatre Bar 9 sound bar for your OLED TV", "soundbar"],
      ["Sony WH-1000XM6 Wireless Noise Cancelling Headphones", "headphones"],
      ["Apple AirPods Pro 3 Wireless Earbuds", "headphones"],
      ["Xbox Series X 1TB Console", "console"],
      ["PS5 PlayStation 5 Slim Console", "console"],
      ["Nintendo Switch 2 Console", "console"],
      ['Apple MacBook Air 13" M4', "laptop"],
      ["HP Pavilion 15 Notebook", "laptop"],
      ['LG 27" UltraGear OLED Gaming Monitor', "monitor"],
      ["Apple iPhone 17 Pro 256GB", "phone"],
      ["Samsung Galaxy S25 Ultra 512GB", "phone"],
      ["Google Pixel 10 Pro", "phone"],
      ['Apple iPad Air 11" M3', "tablet"],
      ["Samsung Galaxy Tab S10 Tablet", "tablet"],
      ["Dyson V15 Detect Stick Vacuum", "vacuum"],
      ["Breville Barista Express Espresso Machine", "coffee-machine"],
      ["De'Longhi Magnifica Coffee Machine", "coffee-machine"],
      ["Mitsubishi Electric 7.1kW Split System", "air-conditioner"],
      ["Kelvinator 2.5kW Air Conditioner", "air-conditioner"],
      ['Samsung 65" QN80H 4K Vision AI UHD Neo QLED Smart TV QA65QN80HAWXXY', "tv"],
      ['LG 65" AI B6 4K Smart OLED TV 2026 OLED65B6PSA', "tv"],
      ['Sony 55" BRAVIA 3 II 4K LED AI Google TV [2026]', "tv"],
    ])("reads %s as %s", (title, expected) => {
      expect(categoryOf(product(title))).toBe(expected);
    });

    it.each([
      ["MOZA ESX Racing Wheel for XBOX Series X/S"],
      ["Powerwave RGB Lighting Stand for Xbox Series X"],
      ["Laser Multi-Region DVD Player"],
      ["Google Pixel Buds Pro 2"],
      ["Samsung Galaxy S Pen"],
      ["Seagate Game Drive Portable 2TB Xbox Hard Drive"],
      [""],
    ])("reads %s as nothing", (title) => {
      expect(categoryOf(product(title))).toBeNull();
    });

    it("prefers the more specific rule when a title names two categories", () => {
      expect(categoryOf(product("Soundbar for your TV"))).toBe("soundbar");
      expect(categoryOf(product("Laptop with OLED display"))).toBe("laptop");
      expect(categoryOf(product("Robot vacuum with smart TV app"))).toBe("vacuum");
    });

    it("takes a TV wall mount and a Switch OLED as TVs, known false positives", () => {
      expect(categoryOf(product("Sanus Full Motion TV Wall Mount"))).toBe("tv");
      expect(categoryOf(product("Nintendo Switch OLED Model"))).toBe("tv");
    });
  });

  describe("on the recorded store answers", () => {
    it("maps the consoles of the JB Hi-Fi Xbox answer, and nothing else in it", () => {
      const categories = categoriesOf("jbhifi-suggest-xbox-series-x.json");
      expect(categories["Xbox Series X 1TB Console"]).toBe("console");
      expect(categories["Xbox Series S 1TB Console (Robot White)"]).toBe("console");
      expect(categories["MOZA ESX Racing Wheel for XBOX Series X/S"]).toBeNull();
      expect(
        Object.entries(categories)
          .filter(([title]) => !title.includes("Console"))
          .every(([, category]) => category === null),
      ).toBe(true);
    });

    it("maps every DVD player of the JB Hi-Fi answer to nothing", () => {
      const categories = categoriesOf("jbhifi-suggest-dvd-player.json");
      expect(Object.keys(categories)).toHaveLength(10);
      expect(Object.values(categories).every((category) => category === null)).toBe(true);
    });

    it("maps every product of the Powerland televisions collection to tv", () => {
      const categories = categoriesOf("powerland-collection-televisions.json");
      expect(Object.keys(categories)).toHaveLength(6);
      expect(Object.values(categories).every((category) => category === "tv")).toBe(true);
    });

    it("maps the Sony TVs of the JB Hi-Fi answer to tv by their titles, and the subwoofer to nothing", () => {
      const categories = categoriesOf("jbhifi-suggest-sony-bravia-8-55.json");
      expect(categories["Sony BRAVIA Theatre Sub 8"]).toBeNull();
      expect(
        Object.entries(categories)
          .filter(([title]) => title !== "Sony BRAVIA Theatre Sub 8")
          .every(([, category]) => category === "tv"),
      ).toBe(true);
    });

    it("maps the Samsung soundbars of the Powerland Xbox answer by title, past their store types", () => {
      const products = fixtureProducts("powerland-suggest-xbox-series-s.json");
      const soundbars = products.filter((product) => product.title.includes("Soundbar"));
      expect(soundbars.map((product) => product.storeType)).toEqual([
        "Subwoofer",
        "Accessory",
        "Subwoofer",
      ]);
      expect(soundbars.map((product) => categoryOf(product))).toEqual([
        "soundbar",
        "soundbar",
        "soundbar",
      ]);
      const others = products.filter((product) => !product.title.includes("Soundbar"));
      expect(others.every((product) => categoryOf(product) === "tv")).toBe(true);
    });

    it("lets a seeded collection's hint override a title that says otherwise", () => {
      const [first] = fixtureProducts("powerland-collection-televisions.json");
      expect(categoryOf({ ...first, hint: "vacuum" })).toBe("vacuum");
      expect(categoryOf({ ...first, hint: "not-a-category" })).toBe("tv");
    });
  });
});
