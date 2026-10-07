import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  compareByRelevance,
  HIDDEN_TIERS,
  isHiddenByDefault,
  judgeRelevance,
  tokenise,
  type Relevance,
  type RelevanceSortKey,
  type RelevanceTier,
} from "./relevance";

/** The titles and brands of one recorded predictive search answer, in the store's order. */
function fixtureCandidates(name: string): { title: string; brand: string | null }[] {
  const body = readFileSync(
    fileURLToPath(new URL(`../sources/fixtures/${name}`, import.meta.url)),
    "utf8",
  );
  const json = JSON.parse(body) as {
    resources: { results: { products: { title: string; vendor: string | null }[] } };
  };
  return json.resources.results.products.map((product) => ({
    title: product.title,
    brand: product.vendor,
  }));
}

/** Title to tier for every product the store returned. */
function tiersOf(query: string, fixture: string): Record<string, RelevanceTier> {
  return Object.fromEntries(
    fixtureCandidates(fixture).map((candidate) => [
      candidate.title,
      judgeRelevance(query, candidate).tier,
    ]),
  );
}

describe("tokenise", () => {
  it("lower-cases and splits on every character that is not a letter or digit", () => {
    expect(tokenise('Samsung 65" S90H OLED [2026]')).toEqual([
      "samsung",
      "65",
      "s90h",
      "oled",
      "2026",
    ]);
    expect(tokenise("Racing Wheel for XBOX Series X/S")).toEqual([
      "racing",
      "wheel",
      "for",
      "xbox",
      "series",
      "x",
      "s",
    ]);
    expect(tokenise("Controller for Xbox Series X|S")).toEqual([
      "controller",
      "for",
      "xbox",
      "series",
      "x",
      "s",
    ]);
    expect(tokenise("Mini-LED")).toEqual(["mini", "led"]);
  });

  it("drops empty tokens and duplicates", () => {
    expect(tokenise("  Xbox  Xbox -- xbox ")).toEqual(["xbox"]);
    expect(tokenise("")).toEqual([]);
    expect(tokenise('--- "" ')).toEqual([]);
  });

  it("strips a trailing possessive, straight or curly, so it leaves no stray s", () => {
    expect(tokenise("Microsoft's Xbox")).toEqual(["microsoft", "xbox"]);
    expect(tokenise("Sony’s Bravia")).toEqual(["sony", "bravia"]);
    expect(tokenise("Logitech G's")).toEqual(["logitech", "g"]);
    // Only a possessive: an apostrophe followed by more than an s is a word break as before.
    expect(tokenise("Rock'n'Roll S'mores")).toEqual(["rock", "n", "roll", "s", "mores"]);
  });
});

describe("judgeRelevance for Xbox Series S", () => {
  const query = "Xbox Series S";
  const tiers = tiersOf(query, "jbhifi-suggest-xbox-series-s.json");

  it("marks the two Series S consoles as matches", () => {
    expect(tiers["Xbox Series S 1TB Console (Robot White)"]).toBe("match");
    expect(tiers["Xbox Series S 512GB Console"]).toBe("match");
  });

  it("marks the two Series X consoles as partial, missing s", () => {
    expect(tiers["Xbox Series X 1TB Digital Console (Robot White)"]).toBe("partial");
    expect(tiers["Xbox Series X 1TB Console"]).toBe("partial");
    const judged = judgeRelevance(query, {
      title: "Xbox Series X 1TB Console",
      brand: "MICROSOFT",
    });
    expect(judged.missing).toEqual(["s"]);
    expect(judged.reason).toBe("missing: s");
  });

  it("marks the Lighting Stand for Series X as partial: xbox and series, but not s", () => {
    expect(tiers["Powerwave RGB Lighting Stand for Xbox Series X"]).toBe("partial");
  });

  it("marks the Seagate Xbox Hard Drive as partial on xbox alone", () => {
    expect(tiers["Seagate Game Drive Portable 2TB Xbox Hard Drive"]).toBe("partial");
  });

  it("marks the Lenovo Legion Go S as unrelated: a one-letter word alone is no partial", () => {
    expect(tiers["Lenovo Legion Go S AMD Ryzen Z1 Extreme (1TB)"]).toBe("unrelated");
    const judged = judgeRelevance(query, {
      title: "Lenovo Legion Go S AMD Ryzen Z1 Extreme (1TB)",
      brand: "LENOVO",
    });
    expect(judged.matched).toEqual(["s"]);
    expect(judged.reason).toBe("missing: xbox, series");
  });

  it("marks the PS5 as unrelated with no query word in the title", () => {
    expect(tiers["PS5 PlayStation 5 Slim Console"]).toBe("unrelated");
    expect(
      judgeRelevance(query, { title: "PS5 PlayStation 5 Slim Console", brand: "SONY COMP" }).reason,
    ).toBe("no query word in the title");
  });

  it("scores the shorter of two matching titles higher", () => {
    const short = judgeRelevance(query, {
      title: "Xbox Series S 512GB Console",
      brand: "MICROSOFT",
    });
    const long = judgeRelevance(query, {
      title: "Xbox Series S 1TB Console (Robot White)",
      brand: "MICROSOFT",
    });
    expect(short.score).toBeGreaterThan(long.score);
    // Phrase bonus 3, three words matched, two extra title words.
    expect(short.score).toBe(5.8);
    expect(long.score).toBe(5.6);
  });

  it("marks everything Powerland returned as partial or unrelated", () => {
    const powerland = Object.values(tiersOf(query, "powerland-suggest-xbox-series-s.json"));
    expect(powerland).toHaveLength(10);
    expect(powerland.every((tier) => tier === "partial" || tier === "unrelated")).toBe(true);
  });
});

describe("judgeRelevance for Xbox Series X", () => {
  const query = "Xbox Series X";
  const tiers = tiersOf(query, "jbhifi-suggest-xbox-series-x.json");

  it("marks the two Series X consoles as matches", () => {
    expect(tiers["Xbox Series X 1TB Console"]).toBe("match");
    expect(tiers["Xbox Series X 1TB Digital Console (Robot White)"]).toBe("match");
  });

  it("marks the racing wheel, the controllers and the charging stands as accessories", () => {
    expect(tiers["MOZA ESX Racing Wheel for XBOX Series X/S"]).toBe("accessory");
    expect(tiers["PowerA Advantage Wireless Controller for XBOX Series X|S (Beach Vibes)"]).toBe(
      "accessory",
    );
    expect(tiers["PowerA Fusion Pro Wireless Controller with Lumectra for Xbox Series X|S"]).toBe(
      "accessory",
    );
    expect(tiers["Powerwave Charging Display Stand for Xbox Series X/S (Black)"]).toBe("accessory");
    expect(tiers["PowerA Dual Charging Station for XBOX Series X/S (Black)"]).toBe("accessory");
    expect(
      tiers["PowerA Advantage Plus Wired Controller for XBOX Series X|S (Moonlit Palms)"],
    ).toBe("accessory");
    expect(
      judgeRelevance(query, { title: "MOZA ESX Racing Wheel for XBOX Series X/S", brand: null })
        .reason,
    ).toBe('accessory for the product ("for" before the name)');
  });

  it("marks the Series S consoles as partial", () => {
    expect(tiers["Xbox Series S 1TB Console (Robot White)"]).toBe("partial");
    expect(tiers["Xbox Series S 512GB Console"]).toBe("partial");
  });
});

describe("judgeRelevance for Samsung S90H 65", () => {
  const query = "Samsung S90H 65";
  const jb = tiersOf(query, "jbhifi-suggest-samsung-s90h-65.json");

  it("marks only the 65-inch S90H as a match", () => {
    expect(jb['Samsung 65" S90H OLED 4K Smart AI TV [2026]']).toBe("match");
    expect(Object.values(jb).filter((tier) => tier === "match")).toHaveLength(1);
  });

  it("marks the other sizes as partial, missing 65", () => {
    for (const size of ["83", "77", "55", "48", "42"]) {
      const title = `Samsung ${size}" S90H OLED 4K Smart AI TV [2026]`;
      expect(jb[title]).toBe("partial");
      expect(judgeRelevance(query, { title, brand: "SAMSUNG" }).reason).toBe("missing: 65");
    }
  });

  it("marks the 65-inch M70H as partial, missing s90h", () => {
    const title = 'Samsung 65" M70H Mini LED 4K Smart AI TV [2026]';
    expect(jb[title]).toBe("partial");
    expect(judgeRelevance(query, { title, brand: "SAMSUNG" }).reason).toBe("missing: s90h");
  });

  it("marks everything Powerland returned as partial or unrelated: no S90H", () => {
    const powerland = tiersOf(query, "powerland-suggest-samsung-s90h-65.json");
    expect(Object.values(powerland)).toHaveLength(10);
    expect(
      Object.values(powerland).every((tier) => tier === "partial" || tier === "unrelated"),
    ).toBe(true);
    expect(powerland['TCL 65" C7L SQD  4K QLED UHD Mini LED Smart Google TV 65C7L']).toBe(
      "unrelated",
    );
  });
});

describe("judgeRelevance for Sony Bravia 8 55", () => {
  const query = "Sony Bravia 8 55";
  const tiers = tiersOf(query, "jbhifi-suggest-sony-bravia-8-55.json");

  it("marks the 55-inch Bravia 8 II as a match, a known false positive of the gap rule: it is not the Bravia 8", () => {
    expect(tiers['Sony 55" BRAVIA 8 II 4K HDR OLED Google TV [2025]']).toBe("match");
  });

  it("marks the 65-inch Bravia 8 II as partial, missing 55", () => {
    const title = 'Sony 65" BRAVIA 8 II 4K HDR OLED Google TV [2025]';
    expect(tiers[title]).toBe("partial");
    expect(judgeRelevance(query, { title, brand: "SONY" }).missing).toEqual(["55"]);
  });

  it("marks the Bravia Theatre Sub 8 as partial", () => {
    expect(tiers["Sony BRAVIA Theatre Sub 8"]).toBe("partial");
  });
});

describe("judgeRelevance for DVD player", () => {
  const query = "DVD player";

  it("marks all ten JB Hi-Fi rows as matches", () => {
    const tiers = Object.values(tiersOf(query, "jbhifi-suggest-dvd-player.json"));
    expect(tiers).toHaveLength(10);
    expect(tiers.every((tier) => tier === "match")).toBe(true);
  });

  it("marks all ten Powerland rows as unrelated", () => {
    const tiers = Object.values(tiersOf(query, "powerland-suggest-dvd-player.json"));
    expect(tiers).toHaveLength(10);
    expect(tiers.every((tier) => tier === "unrelated")).toBe(true);
  });
});

describe("judgeRelevance rules", () => {
  it("counts the brand as part of the candidate", () => {
    const judged = judgeRelevance("Microsoft Xbox Series S", {
      title: "Xbox Series S 512GB Console",
      brand: "MICROSOFT",
    });
    expect(judged.tier).toBe("match");
    expect(judged.matched).toEqual(["microsoft", "xbox", "series", "s"]);
  });

  it("marks a title with an accessory word as an accessory, naming the word", () => {
    const judged = judgeRelevance("Xbox Series X", {
      title: "Xbox Series X Elite Wireless Controller",
      brand: "MICROSOFT",
    });
    expect(judged.tier).toBe("accessory");
    expect(judged.reason).toBe('accessory for the product ("controller" in the title)');
  });

  it("keeps a bundle with a controller as an accessory, a known false negative", () => {
    expect(
      judgeRelevance("Xbox Series X", {
        title: "Xbox Series X 1TB Console with Controller",
        brand: null,
      }).tier,
    ).toBe("accessory");
  });

  it('reads a product "for" someone as an accessory, a known false negative of the "for" rule', () => {
    const judged = judgeRelevance("Xbox Series X", {
      title: "Perfect for gamers: Xbox Series X 1TB Console",
      brand: "MICROSOFT",
    });
    expect(judged.tier).toBe("accessory");
    expect(judged.reason).toBe('accessory for the product ("for" before the name)');
  });

  it("reads a television with a solar remote as an accessory, a known false negative of the accessory words", () => {
    const judged = judgeRelevance("Samsung S90H 65", {
      title: 'Samsung 65" S90H OLED 4K Smart AI TV with Solar Remote',
      brand: "SAMSUNG",
    });
    expect(judged.tier).toBe("accessory");
    expect(judged.reason).toBe('accessory for the product ("remote" in the title)');
  });

  it("reads a disc drive edition console as an accessory, a known false negative of the accessory words", () => {
    const judged = judgeRelevance("Xbox Series X", {
      title: "Xbox Series X 1TB Console Disc Drive Edition",
      brand: null,
    });
    expect(judged.tier).toBe("accessory");
    expect(judged.reason).toBe('accessory for the product ("drive" in the title)');
  });

  it("accepts the Bravia Theatre Sub 8 for Sony Bravia 8, a known false positive of the gap rule", () => {
    expect(
      judgeRelevance("Sony Bravia 8", { title: "Sony BRAVIA Theatre Sub 8", brand: "SONY" }).tier,
    ).toBe("match");
  });

  it("accepts the Bravia 8 II for Sony Bravia 8, a known false positive of the gap rule", () => {
    expect(
      judgeRelevance("Sony Bravia 8", {
        title: 'Sony 55" BRAVIA 8 II 4K HDR OLED Google TV [2025]',
        brand: "SONY",
      }).tier,
    ).toBe("match");
  });

  it("accepts the query words in any order, a known false positive of the order rule", () => {
    expect(
      judgeRelevance("Series X Xbox Console", { title: "Xbox Series X 1TB Console", brand: null })
        .tier,
    ).toBe("match");
  });

  it("no longer lets a possessive satisfy a one-letter query word", () => {
    // "Microsoft's" once tokenised to "microsoft" and "s", and the "s" matched Series S.
    const judged = judgeRelevance("Xbox Series S", {
      title: "Microsoft's Xbox Series X 1TB Console",
      brand: null,
    });
    expect(judged.tier).toBe("partial");
    expect(judged.missing).toEqual(["s"]);
  });

  it("does not apply the accessory rules when the query asks for an accessory", () => {
    expect(
      judgeRelevance("Xbox stand", { title: "Charging Stand for Xbox", brand: null }).tier,
    ).toBe("match");
  });

  it("makes a partial from half the words of a two-word query, even short ones", () => {
    const judged = judgeRelevance("C5 65", { title: 'LG 65" OLED B6', brand: "LG" });
    expect(judged.tier).toBe("partial");
    expect(judged.matched).toEqual(["65"]);
  });

  it("never makes a partial from a two-character word alone in a three-word query", () => {
    expect(judgeRelevance("LG C5 65", { title: 'Sony 65" Bravia', brand: "SONY" }).tier).toBe(
      "unrelated",
    );
  });

  it("gives the phrase bonus only when the words are adjacent and in query order", () => {
    const phrase = judgeRelevance("Bravia 8", { title: "Sony Bravia 8", brand: null });
    const apart = judgeRelevance("Bravia 8", { title: "Sony Bravia Theatre Sub 8", brand: null });
    expect(phrase.score).toBe(4.9);
    expect(apart.score).toBe(1.7);
  });

  it("never scores below zero", () => {
    const padding = Array.from({ length: 50 }, (_, index) => `w${index}`).join(" ");
    const judged = judgeRelevance("tv", { title: `${padding} tv`, brand: null });
    expect(judged.tier).toBe("match");
    expect(judged.score).toBe(0);
  });

  it("treats an empty query as unrelated to everything", () => {
    const judged = judgeRelevance("", { title: "Xbox Series S", brand: null });
    expect(judged.tier).toBe("unrelated");
    expect(judged.matched).toEqual([]);
  });
});

describe("compareByRelevance", () => {
  function key(
    tier: RelevanceTier,
    score: number,
    title: string,
    retailerName?: string,
  ): RelevanceSortKey {
    const relevance: Relevance = { tier, score, matched: [], missing: [], reason: "" };
    return retailerName === undefined ? { relevance, title } : { relevance, title, retailerName };
  }

  it("orders the tiers best first, whatever the score", () => {
    const match = key("match", 0, "z");
    const accessory = key("accessory", 9, "a");
    const partial = key("partial", 9, "a");
    const unrelated = key("unrelated", 9, "a");
    expect(compareByRelevance(match, accessory)).toBeLessThan(0);
    expect(compareByRelevance(accessory, partial)).toBeLessThan(0);
    expect(compareByRelevance(partial, unrelated)).toBeLessThan(0);
    expect(compareByRelevance(unrelated, match)).toBeGreaterThan(0);
  });

  it("orders the higher score first within a tier", () => {
    expect(compareByRelevance(key("match", 5.8, "b"), key("match", 5.6, "a"))).toBeLessThan(0);
  });

  it("orders equal scores by title in the en collation", () => {
    expect(compareByRelevance(key("match", 5, "Apple"), key("match", 5, "Blaupunkt"))).toBeLessThan(
      0,
    );
    expect(
      compareByRelevance(key("match", 5, "blaupunkt"), key("match", 5, "Apple")),
    ).toBeGreaterThan(0);
  });

  it("breaks a tie on title by retailer name, treating a missing name as empty", () => {
    const jb = key("match", 5, "Xbox Series S 512GB Console", "JB Hi-Fi");
    const powerland = key("match", 5, "Xbox Series S 512GB Console", "Powerland");
    const nameless = key("match", 5, "Xbox Series S 512GB Console");
    expect(compareByRelevance(jb, powerland)).toBeLessThan(0);
    expect(compareByRelevance(powerland, jb)).toBeGreaterThan(0);
    expect(compareByRelevance(nameless, jb)).toBeLessThan(0);
    expect(compareByRelevance(nameless, key("match", 5, "Xbox Series S 512GB Console"))).toBe(0);
  });

  it("sorts a mixed list the way the service and the lab page show it", () => {
    const sorted = [
      key("partial", 2, "c", "JB Hi-Fi"),
      key("match", 5.6, "b", "Powerland"),
      key("accessory", 7, "a", "JB Hi-Fi"),
      key("match", 5.8, "b", "JB Hi-Fi"),
      key("match", 5.6, "b", "JB Hi-Fi"),
      key("unrelated", 0, "d", "JB Hi-Fi"),
    ].sort(compareByRelevance);
    expect(
      sorted.map(
        (entry) =>
          `${entry.relevance.tier} ${entry.relevance.score} ${entry.title} ${entry.retailerName}`,
      ),
    ).toEqual([
      "match 5.8 b JB Hi-Fi",
      "match 5.6 b JB Hi-Fi",
      "match 5.6 b Powerland",
      "accessory 7 a JB Hi-Fi",
      "partial 2 c JB Hi-Fi",
      "unrelated 0 d JB Hi-Fi",
    ]);
  });
});

describe("isHiddenByDefault", () => {
  it.each<[RelevanceTier, boolean]>([
    ["match", false],
    ["accessory", false],
    ["partial", true],
    ["unrelated", true],
  ])("hides a row of tier %s by default: %s", (tier, hidden) => {
    expect(isHiddenByDefault(tier)).toBe(hidden);
  });

  it("hides exactly the tiers in HIDDEN_TIERS, the two below accessory", () => {
    expect(Array.from(HIDDEN_TIERS).sort()).toEqual(["partial", "unrelated"]);
  });
});
