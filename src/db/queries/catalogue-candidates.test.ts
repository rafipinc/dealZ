import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../test-db";
import {
  type CatalogueCandidateInsert,
  countCatalogueCandidates,
  databaseNow,
  deleteUnseenListingRows,
  MAX_SEARCH_LIMIT,
  searchCatalogueCandidates,
  upsertCatalogueCandidates,
} from "./catalogue-candidates";

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
});

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  await t.truncate("catalogue_candidate");
});

const lgC6: CatalogueCandidateInsert = {
  retailerSlug: "jb-hi-fi",
  handle: "lg-65-oled-evo-ai-c6-4k-smart-tv-2026",
  canonicalUrl: "https://www.jbhifi.com.au/products/lg-65-oled-evo-ai-c6-4k-smart-tv-2026",
  title: 'LG 65" OLED EVO AI C6 4K Smart TV [2026]',
  brand: "LG",
  storeType: "TVs",
  mpn: "OLED65C6PSA",
  gtin: "08806096123456",
  retailerSku: "123456",
  priceCents: 3_995_00,
  compareAtCents: 4_999_00,
  available: true,
  imageUrl: "https://cdn.example/lg-c6.jpg",
  source: "search",
  raw: { id: 1 },
};

const s90h: CatalogueCandidateInsert = {
  retailerSlug: "jb-hi-fi",
  handle: "samsung-65-s90h-oled-4k-smart-tv-2026",
  canonicalUrl: "https://www.jbhifi.com.au/products/samsung-65-s90h-oled-4k-smart-tv-2026",
  title: 'Samsung 65" S90H OLED 4K Smart TV [2026]',
  brand: "Samsung",
  mpn: "QA65S90HAWXXY",
  retailerSku: "654321",
  priceCents: 3_495_00,
  source: "listing",
};

const powerlandDvd: CatalogueCandidateInsert = {
  retailerSlug: "powerland",
  handle: "laser-dvd-player-hdmi",
  canonicalUrl: "https://powerland.com.au/products/laser-dvd-player-hdmi",
  title: "Laser DVD Player with HDMI",
  priceCents: 49_00,
  source: "listing",
};

const all = () =>
  t.db.query.catalogueCandidate.findMany({ orderBy: (c, { asc }) => asc(c.handle) });

describe("upsertCatalogueCandidates", () => {
  it("inserts new rows with the defaults filled in and returns the count", async () => {
    expect(await upsertCatalogueCandidates(t.db, [lgC6, s90h, powerlandDvd])).toBe(3);

    const rows = await all();
    expect(rows).toHaveLength(3);
    const dvd = rows.find((r) => r.handle === powerlandDvd.handle);
    expect(dvd?.currency).toBe("AUD");
    expect(dvd?.raw).toEqual({});
    expect(dvd?.available).toBeNull();
    expect(dvd?.firstSeenAt).toBeInstanceOf(Date);
    expect(dvd?.lastSeenAt).toEqual(dvd?.firstSeenAt);
  });

  it("writes nothing and returns zero for an empty batch", async () => {
    expect(await upsertCatalogueCandidates(t.db, [])).toBe(0);
    expect(await all()).toEqual([]);
  });

  it("replaces a known row in place by retailer and handle", async () => {
    await upsertCatalogueCandidates(t.db, [lgC6]);
    const [before] = await all();

    const written = await upsertCatalogueCandidates(t.db, [
      {
        ...lgC6,
        title: 'LG 65" OLED evo AI C6 4K Smart TV (2026)',
        priceCents: 3_495_00,
        compareAtCents: null,
        available: false,
        source: "inspect",
        raw: { id: 2 },
      },
    ]);
    const rows = await all();

    expect(written).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(before.id);
    expect(rows[0].title).toBe('LG 65" OLED evo AI C6 4K Smart TV (2026)');
    expect(rows[0].priceCents).toBe(3_495_00);
    expect(rows[0].compareAtCents).toBeNull();
    expect(rows[0].available).toBe(false);
    expect(rows[0].source).toBe("inspect");
    expect(rows[0].raw).toEqual({ id: 2 });
  });

  it("keeps first_seen_at and moves last_seen_at on a repeat sighting", async () => {
    await upsertCatalogueCandidates(t.db, [lgC6]);
    const [before] = await all();
    // Clock resolution is microseconds; make sure now() has moved on.
    await t.exec("SELECT pg_sleep(0.01)");

    await upsertCatalogueCandidates(t.db, [lgC6]);
    const [after] = await all();

    expect(after.firstSeenAt).toEqual(before.firstSeenAt);
    expect(after.lastSeenAt.getTime()).toBeGreaterThan(before.lastSeenAt.getTime());
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
  });

  it("keeps a stored gtin, mpn, retailer_sku and image_url when the new row has none", async () => {
    await upsertCatalogueCandidates(t.db, [lgC6]);

    await upsertCatalogueCandidates(t.db, [
      { ...lgC6, gtin: null, mpn: null, retailerSku: null, imageUrl: null, brand: null },
    ]);
    const [row] = await all();

    expect(row.gtin).toBe(lgC6.gtin);
    expect(row.mpn).toBe(lgC6.mpn);
    expect(row.retailerSku).toBe(lgC6.retailerSku);
    expect(row.imageUrl).toBe(lgC6.imageUrl);
    // Every other mutable column takes the new value, null included.
    expect(row.brand).toBeNull();
  });

  it("overwrites a stored identifier when the new row carries one", async () => {
    await upsertCatalogueCandidates(t.db, [{ ...lgC6, gtin: null }]);
    await upsertCatalogueCandidates(t.db, [{ ...lgC6, gtin: "08806096123456" }]);
    await upsertCatalogueCandidates(t.db, [{ ...lgC6, gtin: "08806096999999" }]);

    const [row] = await all();
    expect(row.gtin).toBe("08806096999999");
  });

  it("treats the same handle at two retailers as two rows", async () => {
    await upsertCatalogueCandidates(t.db, [
      lgC6,
      { ...lgC6, retailerSlug: "powerland", canonicalUrl: "https://powerland.com.au/products/x" },
    ]);

    expect(await all()).toHaveLength(2);
  });

  it("surfaces a constraint violation instead of swallowing it", async () => {
    await expect(upsertCatalogueCandidates(t.db, [{ ...lgC6, priceCents: -1 }])).rejects.toThrow();
    expect(await all()).toEqual([]);
  });
});

describe("searchCatalogueCandidates", () => {
  beforeEach(async () => {
    await upsertCatalogueCandidates(t.db, [lgC6, s90h, powerlandDvd]);
  });

  const titles = async (query: string, limit = 10) =>
    (await searchCatalogueCandidates(t.db, { query, limit })).map((r) => r.title);

  it.each([
    ["LG 65 C6", [lgC6.title]],
    ["lg c6", [lgC6.title]],
    ["dvd player", [powerlandDvd.title]],
  ])("finds %s by trigram similarity on the title", async (query, expected) => {
    expect(await titles(query)).toEqual(expected);
  });

  it("finds a substring the trigrams alone would not reach", async () => {
    // Three characters inside one word: similarity is tiny, ILIKE still hits.
    expect(await titles("S90")).toEqual([s90h.title]);
  });

  it.each([
    ["gtin", "08806096123456", lgC6.title],
    ["mpn", "QA65S90HAWXXY", s90h.title],
    ["retailer_sku", "654321", s90h.title],
  ])("finds a row by exact %s", async (_column, query, expected) => {
    expect(await titles(query)).toEqual([expected]);
  });

  it("does not match an identifier by prefix", async () => {
    expect(await titles("0880609612345")).toEqual([]);
  });

  it("orders the best title match first", async () => {
    const found = await titles('65" OLED 4K Smart TV LG C6');
    expect(found[0]).toBe(lgC6.title);
    expect(found).toContain(s90h.title);
    expect(found).not.toContain(powerlandDvd.title);
  });

  it("treats LIKE wildcards in the query as characters", async () => {
    expect(await titles("%")).toEqual([]);
    expect(await titles("_____")).toEqual([]);
  });

  it("returns nothing for a blank query", async () => {
    expect(await titles("   ")).toEqual([]);
  });

  it("applies the limit and caps it at the maximum", async () => {
    expect(await titles("smart tv", 1)).toHaveLength(1);
    expect(await titles("smart tv", MAX_SEARCH_LIMIT + 1_000)).toHaveLength(2);
  });

  it("returns nothing for a limit of zero", async () => {
    expect(await titles("smart tv", 0)).toEqual([]);
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["a fraction", 1.5],
    ["a negative number", -1],
  ])("falls back to the default limit when the limit is %s", async (_label, limit) => {
    expect(await titles("smart tv", limit)).toHaveLength(2);
  });
});

describe("deleteUnseenListingRows", () => {
  const seenSince = new Date("2026-10-06T00:00:00Z");
  const stale = new Date("2026-10-05T23:59:59Z");
  const fresh = new Date("2026-10-06T00:00:01Z");

  const staleListing = { ...s90h, lastSeenAt: stale };
  const freshListing = {
    ...s90h,
    handle: "samsung-55-s90h-oled-4k-smart-tv-2026",
    canonicalUrl: "https://www.jbhifi.com.au/products/samsung-55-s90h-oled-4k-smart-tv-2026",
    title: 'Samsung 55" S90H OLED 4K Smart TV [2026]',
    lastSeenAt: fresh,
  };
  const staleSearch = { ...lgC6, source: "search", lastSeenAt: stale };
  const staleInspect = {
    ...lgC6,
    handle: "lg-55-oled-evo-ai-c6-4k-smart-tv-2026",
    canonicalUrl: "https://www.jbhifi.com.au/products/lg-55-oled-evo-ai-c6-4k-smart-tv-2026",
    title: 'LG 55" OLED EVO AI C6 4K Smart TV [2026]',
    source: "inspect",
    lastSeenAt: stale,
  };
  const otherRetailerStaleListing = { ...powerlandDvd, lastSeenAt: stale };

  beforeEach(async () => {
    await upsertCatalogueCandidates(t.db, [
      staleListing,
      freshListing,
      staleSearch,
      staleInspect,
      otherRetailerStaleListing,
    ]);
  });

  it("deletes only that retailer's listing rows last seen before the cut-off and returns the count", async () => {
    const deleted = await deleteUnseenListingRows(t.db, { retailerSlug: "jb-hi-fi", seenSince });

    expect(deleted).toBe(1);
    const handles = (await all()).map((r) => r.handle);
    expect(handles).not.toContain(staleListing.handle);
    expect(handles).toEqual(
      expect.arrayContaining([
        freshListing.handle,
        staleSearch.handle,
        staleInspect.handle,
        otherRetailerStaleListing.handle,
      ]),
    );
    expect(handles).toHaveLength(4);
  });

  it("leaves a listing row seen exactly at the cut-off", async () => {
    await upsertCatalogueCandidates(t.db, [
      {
        ...s90h,
        handle: "samsung-77-s90h-oled-4k-smart-tv-2026",
        canonicalUrl: "https://www.jbhifi.com.au/products/samsung-77-s90h-oled-4k-smart-tv-2026",
        lastSeenAt: seenSince,
      },
    ]);

    expect(await deleteUnseenListingRows(t.db, { retailerSlug: "jb-hi-fi", seenSince })).toBe(1);
    const handles = (await all()).map((r) => r.handle);
    expect(handles).toContain("samsung-77-s90h-oled-4k-smart-tv-2026");
    expect(handles).toHaveLength(5);
  });

  it("returns zero and deletes nothing for a retailer with no rows", async () => {
    expect(await deleteUnseenListingRows(t.db, { retailerSlug: "nowhere", seenSince })).toBe(0);
    expect(await all()).toHaveLength(5);
  });
});

describe("databaseNow", () => {
  // now(), not clock_timestamp(): the harness autocommits each statement, so
  // now() advances between calls, and now() is what stamps last_seen_at.

  it("returns the database clock as a Date", async () => {
    const before = await databaseNow(t.db);
    await t.exec("SELECT pg_sleep(0.01)");
    const after = await databaseNow(t.db);

    expect(before).toBeInstanceOf(Date);
    expect(Number.isNaN(before.getTime())).toBe(false);
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });

  it("is the clock last_seen_at is stamped with", async () => {
    const before = await databaseNow(t.db);
    await upsertCatalogueCandidates(t.db, [s90h]);
    const [row] = await all();

    expect(row.lastSeenAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  it("keeps a listing row seen after the cut-off when the cut-off comes from it", async () => {
    // A listing row from an earlier read, which the refresh should drop.
    await upsertCatalogueCandidates(t.db, [powerlandDvd]);
    await t.exec("SELECT pg_sleep(0.01)");

    const seenSince = await databaseNow(t.db);
    await upsertCatalogueCandidates(t.db, [s90h]);

    expect(await deleteUnseenListingRows(t.db, { retailerSlug: "jb-hi-fi", seenSince })).toBe(0);
    expect(await deleteUnseenListingRows(t.db, { retailerSlug: "powerland", seenSince })).toBe(1);
    expect((await all()).map((r) => r.handle)).toEqual([s90h.handle]);
  });
});

describe("countCatalogueCandidates", () => {
  it("counts rows overall and per retailer with the latest sighting", async () => {
    await upsertCatalogueCandidates(t.db, [lgC6, s90h, powerlandDvd]);
    const rows = await all();
    const latest = (slug: string) =>
      Math.max(...rows.filter((r) => r.retailerSlug === slug).map((r) => r.lastSeenAt.getTime()));

    const counts = await countCatalogueCandidates(t.db);

    expect(counts.total).toBe(3);
    expect(counts.byRetailer.map((r) => [r.retailerSlug, r.count, r.lastSeenAt.getTime()])).toEqual(
      [
        ["jb-hi-fi", 2, latest("jb-hi-fi")],
        ["powerland", 1, latest("powerland")],
      ],
    );
  });

  it("reports an empty index as zero with no retailers", async () => {
    expect(await countCatalogueCandidates(t.db)).toEqual({ total: 0, byRetailer: [] });
  });
});
