import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  HISTORY_EVIDENCE_CONFIDENCE,
  MIN_STRONG_QUOTE_LENGTH,
  WEAK_MATCH_WINDOW,
  assessClaim,
  dateFromHtml,
  dateFromUrl,
  findFragment,
  normaliseText,
  pointsFromModelText,
  type AssessClaimInput,
} from "./history-evidence";
import { visibleText } from "./page-text";

const fixture = (name: string) =>
  readFileSync(new URL(`../sources/fixtures/${name}`, import.meta.url), "utf8");

const identifiers = { modelCode: "QA65S85HAEXXY", gtin: "08806097962670" };
const noIdentifiers = { modelCode: null, gtin: null };

const filler = (n: number, char = "x") => char.repeat(n);

describe("normaliseText", () => {
  it("collapses runs of whitespace to one space and trims", () => {
    expect(normaliseText('  Samsung\n\t65"  OLED \r\n TV  ')).toBe('Samsung 65" OLED TV');
  });

  it("straightens curly quotes and apostrophes", () => {
    expect(normaliseText("“Samsung” 65″ ‘OLED’ it’s")).toBe("\"Samsung\" 65\" 'OLED' it's");
  });

  it("strips soft hyphens and zero-width characters", () => {
    expect(normaliseText("QA65­S85H​AEXXY﻿")).toBe("QA65S85HAEXXY");
  });

  it("keeps case", () => {
    expect(normaliseText("OLED tv")).toBe("OLED tv");
  });
});

describe("findFragment", () => {
  it("never verifies a quote that does not carry the claimed price", () => {
    const page = 'Samsung 65" OLED 4K Smart AI TV 902825 / QA65S85HAEXXY $2,495.00 ticket $3,295';
    const quote = 'Samsung 65" OLED 4K Smart AI TV';
    expect(findFragment(page, quote, { modelCode: "QA65S85HAEXXY", gtin: null }, 99900)).toBe(
      "absent",
    );
    expect(findFragment(page, quote, { modelCode: "QA65S85HAEXXY", gtin: null }, 249500)).toBe(
      "weak",
    );
    expect(
      findFragment(
        page,
        `${quote} 902825 / QA65S85HAEXXY $2,495.00`,
        { modelCode: "QA65S85HAEXXY", gtin: null },
        249500,
      ),
    ).toBe("strong");
  });

  const page =
    'Samsung 65" OLED 4K Smart AI TV 902825 / QA65S85HAEXXY now $2,495.00 was $3,295 (EAN 8806097962670)';

  it("is strong when the quote is on the page verbatim", () => {
    expect(findFragment(page, "902825 / QA65S85HAEXXY now $2,495.00", identifiers, 249500)).toBe(
      "strong",
    );
  });

  it("is strong regardless of case, whitespace runs and curly quotes", () => {
    expect(
      findFragment(
        page,
        "samsung  65” oled 4k\nsmart ai tv 902825 / qa65s85haexxy now $2,495.00",
        noIdentifiers,
        249500,
      ),
    ).toBe("strong");
  });

  it("drops a leading or trailing ellipsis from the quote before matching", () => {
    expect(findFragment(page, "...now $2,495.00 was $3,295...", noIdentifiers, 249500)).toBe(
      "strong",
    );
    expect(
      findFragment(page, "… 902825 / QA65S85HAEXXY now $2,495.00 …", noIdentifiers, 249500),
    ).toBe("strong");
  });

  it("never calls a quote shorter than eight characters strong", () => {
    const short = "$2,495";
    expect(short.length).toBeLessThan(MIN_STRONG_QUOTE_LENGTH);
    expect(findFragment(page, short, identifiers, 249500)).toBe("weak");
    expect(findFragment(page, short, noIdentifiers, 249500)).toBe("absent");
  });

  it("is weak when the price and the model code sit 100 characters apart", () => {
    const text = `Model QA65S85HAEXXY ${filler(100)} Price $2,795`;
    expect(findFragment(text, "not on this page at all", identifiers, 279500)).toBe("weak");
  });

  it("is absent when the price and the model code sit 2,000 characters apart", () => {
    const text = `Model QA65S85HAEXXY ${filler(2000)} Price $2,795`;
    expect(2000).toBeGreaterThan(WEAK_MATCH_WINDOW);
    expect(findFragment(text, "not on this page at all", identifiers, 279500)).toBe("absent");
  });

  it("is weak on the GTIN as well as the model code, with or without leading zeros", () => {
    const text = `EAN 8806097962670 ${filler(50)} $2,795`;
    expect(
      findFragment(text, "nothing verbatim", { modelCode: null, gtin: "08806097962670" }, 279500),
    ).toBe("weak");
    expect(
      findFragment(text, "nothing verbatim", { modelCode: null, gtin: "8806097962670" }, 279500),
    ).toBe("weak");
  });

  it("matches the model code case-insensitively for a weak match", () => {
    expect(findFragment("qa65s85haexxy $2795", "nothing verbatim", identifiers, 279500)).toBe(
      "weak",
    );
  });

  it.each(["$2,795", "$2795", "2795.00", "$2,795.00", "$ 2,795"])(
    "accepts %s as the price for 279500 cents",
    (printed) => {
      expect(
        findFragment(`QA65S85HAEXXY ${printed}`, "nothing verbatim", identifiers, 279500),
      ).toBe("weak");
    },
  );

  it("does not take a bare number, a longer number or a different cents value as the price", () => {
    expect(findFragment("QA65S85HAEXXY 2795", "nothing verbatim", identifiers, 279500)).toBe(
      "absent",
    );
    expect(findFragment("QA65S85HAEXXY $27950", "nothing verbatim", identifiers, 279500)).toBe(
      "absent",
    );
    expect(findFragment("QA65S85HAEXXY $12,795", "nothing verbatim", identifiers, 279500)).toBe(
      "absent",
    );
    expect(findFragment("QA65S85HAEXXY $2,795.50", "nothing verbatim", identifiers, 279500)).toBe(
      "absent",
    );
  });

  it("matches a price with cents only when the cents agree", () => {
    expect(findFragment("QA65S85HAEXXY $2,795.50", "nothing verbatim", identifiers, 279550)).toBe(
      "weak",
    );
    expect(findFragment("QA65S85HAEXXY $2,795", "nothing verbatim", identifiers, 279550)).toBe(
      "absent",
    );
  });

  it("is absent when neither the quote nor the price is on the page", () => {
    expect(findFragment(page, "LG OLED65C5 $3,999", identifiers, 399900)).toBe("absent");
  });

  it("is absent when the price is there but no identifier is known", () => {
    expect(findFragment(page, "nothing verbatim", noIdentifiers, 249500)).toBe("absent");
  });
});

describe("dateFromUrl", () => {
  it.each([
    ["https://catalogue.jbhifi.com.au/2026/05/28-05-syt/index.html", "2026-05-28"],
    ["https://catalogue.jbhifi.com.au/2026/07/02-07-acp/index.html", "2026-07-02"],
    ["https://catalogue.jbhifi.com.au/2026/09/03-09-ldd/index.html", "2026-09-03"],
  ])("reads the JB Hi-Fi catalogue path %s as %s", (url, expected) => {
    expect(dateFromUrl(url)).toBe(expected);
  });

  it("reads a catalogue path without a scheme", () => {
    expect(dateFromUrl("catalogue.jbhifi.com.au/2026/05/28-05-syt/index.html")).toBe("2026-05-28");
  });

  it("returns null when the catalogue DD-MM segment disagrees with the month folder", () => {
    expect(dateFromUrl("https://catalogue.jbhifi.com.au/2026/05/28-06-syt/index.html")).toBeNull();
  });

  it("reads a /YYYY/MM/DD/ path", () => {
    expect(
      dateFromUrl("https://press-start.com.au/news/2026/03/16/samsung-s85h-oled-tv-sale/"),
    ).toBe("2026-03-16");
  });

  it("reads an ISO date in the query string", () => {
    expect(dateFromUrl("https://example.com.au/deals?published=2026-04-09&page=2")).toBe(
      "2026-04-09",
    );
  });

  it("reads an ISO date in the path", () => {
    expect(dateFromUrl("https://example.com.au/blog/2026-01-05-tv-sale")).toBe("2026-01-05");
  });

  it("returns null for a bare domain", () => {
    expect(dateFromUrl("https://www.jbhifi.com.au/")).toBeNull();
    expect(dateFromUrl("jbhifi.com.au")).toBeNull();
  });

  it("never reads a date from the domain", () => {
    expect(dateFromUrl("https://2026-05-28.example.com/tv")).toBeNull();
    expect(dateFromUrl("https://2026.05.28.example.com/tv")).toBeNull();
  });

  it("returns null for an invalid calendar date", () => {
    expect(dateFromUrl("https://example.com.au/news/2026/02/30/sale")).toBeNull();
    expect(dateFromUrl("https://example.com.au/deals?d=2026-13-01")).toBeNull();
    expect(dateFromUrl("https://catalogue.jbhifi.com.au/2026/04/31-04-syt/index.html")).toBeNull();
  });

  it("accepts a leap day", () => {
    expect(dateFromUrl("https://example.com.au/news/2028/02/29/sale")).toBe("2028-02-29");
  });

  it("returns null for an empty or unparseable URL", () => {
    expect(dateFromUrl("")).toBeNull();
    expect(dateFromUrl("http://")).toBeNull();
  });
});

describe("dateFromHtml", () => {
  it("reads JSON-LD datePublished and returns the date part", () => {
    const html = `<script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2026-07-12T10:26:09+1000"}</script>`;
    expect(dateFromHtml(html)).toBe("2026-07-12");
  });

  it("reads meta article:published_time", () => {
    expect(
      dateFromHtml('<meta content="2026-03-16T08:00:00Z" property="article:published_time" />'),
    ).toBe("2026-03-16");
  });

  it("reads meta itemprop datePublished", () => {
    expect(dateFromHtml("<meta itemprop='datePublished' content='2026-02-01'>")).toBe("2026-02-01");
  });

  it("reads a time element's datetime", () => {
    expect(dateFromHtml('<time datetime="2026-01-20T09:30" class="posted">20 Jan</time>')).toBe(
      "2026-01-20",
    );
  });

  it("prefers JSON-LD over meta and meta over time", () => {
    const html = `<time datetime="2026-01-01"></time>
      <meta property="article:published_time" content="2026-02-02">
      <script type="application/ld+json">{"datePublished":"2026-03-03"}</script>`;
    expect(dateFromHtml(html)).toBe("2026-03-03");
    expect(dateFromHtml(html.replace(/<script[\s\S]*<\/script>/, ""))).toBe("2026-02-02");
  });

  it("passes over a candidate that holds no date", () => {
    const html = `<script type="application/ld+json">{"datePublished":"last Tuesday"}</script>
      <time datetime="2026-01-20">20 Jan</time>`;
    expect(dateFromHtml(html)).toBe("2026-01-20");
  });

  it("returns null for an invalid calendar date", () => {
    expect(dateFromHtml('<time datetime="2026-02-30"></time>')).toBeNull();
  });

  it("never reads dd/mm/yyyy labels from visible text", () => {
    expect(dateFromHtml("<p>Started 21/05/2026</p><p>Started 28/05/2026</p>")).toBeNull();
  });

  it("returns null when a page carries no date", () => {
    expect(dateFromHtml("<html><body><p>$2,795</p></body></html>")).toBeNull();
  });

  it("finds 2026-07-12 on the recorded OzBargain deal page", () => {
    expect(dateFromHtml(fixture("ozbargain-967536.html"))).toBe("2026-07-12");
  });
});

describe("assessClaim", () => {
  const pageText = `Samsung 65" OLED 4K Smart AI TV 902825 / QA65S85HAEXXY now $2,495.00`;
  const datedHtml = `<html><head><meta property="article:published_time" content="2026-06-01"></head><body>${pageText}</body></html>`;
  const undatedHtml = `<html><body>${pageText}</body></html>`;
  const strongQuote = "QA65S85HAEXXY now $2,495.00";
  const weakQuote = "a sentence the page does not carry";

  const input = (overrides: Partial<AssessClaimInput> = {}): AssessClaimInput => ({
    claim: {
      priceCents: 249500,
      sourceUrl: "https://example.com.au/deals/samsung",
      quote: strongQuote,
    },
    identifiers,
    page: { status: "fetched", html: datedHtml, text: pageText },
    ...overrides,
  });

  it("keeps a verified point at or above the review threshold and every other outcome below it", () => {
    const threshold = 0.7; // REVIEW_THRESHOLD in src/sources/types.ts; src/lib imports nothing from there.
    expect(HISTORY_EVIDENCE_CONFIDENCE.verified).toBeGreaterThanOrEqual(threshold);
    expect(HISTORY_EVIDENCE_CONFIDENCE.candidateDated).toBeLessThan(threshold);
    expect(HISTORY_EVIDENCE_CONFIDENCE.candidateUndated).toBeLessThan(threshold);
    expect(HISTORY_EVIDENCE_CONFIDENCE.unverified).toBeLessThan(threshold);
    expect(HISTORY_EVIDENCE_CONFIDENCE.rejected).toBeLessThan(threshold);
  });

  it("marks a claim unverified at 0.4 when the page is unreachable, naming the kind", () => {
    const result = assessClaim(input({ page: { status: "unreachable", kind: "timeout" } }));
    expect(result).toEqual({
      verdict: "unverified",
      confidence: 0.4,
      observedDate: null,
      fragment: null,
      dateSource: null,
      reasons: ["page unreachable: timeout"],
    });
  });

  it("rejects a claim at 0.3 when the quoted fragment is absent", () => {
    const result = assessClaim(
      input({
        claim: { priceCents: 399900, sourceUrl: "https://example.com.au/x", quote: weakQuote },
      }),
    );
    expect(result.verdict).toBe("rejected");
    expect(result.confidence).toBe(0.3);
    expect(result.fragment).toBe("absent");
    expect(result.observedDate).toBeNull();
    expect(result.reasons).toContain("quoted fragment not on page");
  });

  it("verifies at 0.8 a strong fragment on a page dated by its markup", () => {
    const result = assessClaim(input());
    expect(result.verdict).toBe("verified");
    expect(result.confidence).toBe(0.8);
    expect(result.fragment).toBe("strong");
    expect(result.observedDate).toBe("2026-06-01");
    expect(result.dateSource).toBe("page");
  });

  it("dates from the URL before the page", () => {
    const result = assessClaim(
      input({
        claim: {
          priceCents: 249500,
          sourceUrl: "https://press-start.com.au/news/2026/03/16/sale/",
          quote: strongQuote,
        },
      }),
    );
    expect(result.observedDate).toBe("2026-03-16");
    expect(result.dateSource).toBe("url");
  });

  it("marks a weak fragment on a dated page as a candidate at 0.6", () => {
    const result = assessClaim(
      input({
        claim: { priceCents: 249500, sourceUrl: "https://example.com.au/x", quote: weakQuote },
      }),
    );
    expect(result.verdict).toBe("candidate");
    expect(result.confidence).toBe(0.6);
    expect(result.fragment).toBe("weak");
    expect(result.observedDate).toBe("2026-06-01");
    expect(result.reasons).toContain(
      "price and identifier near each other, fragment not found verbatim",
    );
  });

  it("marks a strong fragment on an undated page as a candidate at 0.5 with no date", () => {
    const result = assessClaim(
      input({ page: { status: "fetched", html: undatedHtml, text: pageText } }),
    );
    expect(result.verdict).toBe("candidate");
    expect(result.confidence).toBe(0.5);
    expect(result.fragment).toBe("strong");
    expect(result.observedDate).toBeNull();
    expect(result.dateSource).toBeNull();
    expect(result.reasons).toContain("page carries no date");
  });

  it("marks a weak fragment on an undated page as a candidate at 0.5", () => {
    const result = assessClaim(
      input({
        claim: { priceCents: 249500, sourceUrl: "https://example.com.au/x", quote: weakQuote },
        page: { status: "fetched", html: undatedHtml, text: pageText },
      }),
    );
    expect(result.verdict).toBe("candidate");
    expect(result.confidence).toBe(0.5);
    expect(result.fragment).toBe("weak");
    expect(result.observedDate).toBeNull();
  });

  it("verifies the S85H point on the recorded JB Hi-Fi catalogue of 2026-05-28", () => {
    const html = fixture("jbhifi-catalogue-2026-05-28.html");
    const result = assessClaim({
      claim: {
        priceCents: 249500,
        sourceUrl: "https://catalogue.jbhifi.com.au/2026/05/28-05-syt/index.html",
        quote:
          '$2495 $800 OFF^ TICKET $3295 120 Hz OLED 65" OLED 4K Smart AI TV 902825 / QA65S85HAEXXY',
      },
      identifiers: { modelCode: "QA65S85HAEXXY", gtin: null },
      page: { status: "fetched", html, text: visibleText(html) },
    });
    expect(result.verdict).toBe("verified");
    expect(result.confidence).toBe(0.8);
    expect(result.fragment).toBe("strong");
    expect(result.observedDate).toBe("2026-05-28");
    expect(result.dateSource).toBe("url");
  });
});

describe("pointsFromModelText", () => {
  const row = {
    date: "2026-05-28",
    retailer: "JB Hi-Fi",
    price_aud: 2495,
    source_url: "https://catalogue.jbhifi.com.au/2026/05/28-05-syt/index.html",
    quote: "$2495 $800 OFF^",
  };
  const expected = {
    retailer: "JB Hi-Fi",
    priceCents: 249500,
    sourceUrl: row.source_url,
    quote: row.quote,
    claimedDate: "2026-05-28",
  };

  it("parses a bare JSON array", () => {
    expect(pointsFromModelText(JSON.stringify([row]))).toEqual([expected]);
  });

  it("parses an array inside a json code fence", () => {
    const text = "Here are the points:\n```json\n" + JSON.stringify([row], null, 2) + "\n```\n";
    expect(pointsFromModelText(text)).toEqual([expected]);
  });

  it("parses an array embedded in prose", () => {
    const text = `I found one point [see below]. ${JSON.stringify([row])} Let me know if you need more.`;
    expect(pointsFromModelText(text)).toEqual([expected]);
  });

  it("reads a string price with a comma, a symbol or cents", () => {
    const rows = [
      { ...row, price_aud: "2,795" },
      { ...row, price_aud: "$2,795.50" },
      { ...row, price_aud: "2795.005" },
    ];
    expect(pointsFromModelText(JSON.stringify(rows)).map((p) => p.priceCents)).toEqual([
      279500, 279550, 279501,
    ]);
  });

  it("rounds a numeric price half up to cents", () => {
    const rows = [
      { ...row, price_aud: 1.005 },
      { ...row, price_aud: 1.004 },
      { ...row, price_aud: 2794.999 },
    ];
    expect(pointsFromModelText(JSON.stringify(rows)).map((p) => p.priceCents)).toEqual([
      101, 100, 279500,
    ]);
  });

  it("drops a row without a URL or without a numeric price", () => {
    const rows = [
      { ...row, source_url: "" },
      { ...row, source_url: undefined },
      { ...row, price_aud: "around two and a half grand" },
      { ...row, price_aud: null },
      { ...row, price_aud: -5 },
      "not a row",
      row,
    ];
    expect(pointsFromModelText(JSON.stringify(rows))).toEqual([expected]);
  });

  it("keeps the claimed date for display only and nulls a missing one", () => {
    const [point] = pointsFromModelText(JSON.stringify([{ ...row, date: undefined }]));
    expect(point.claimedDate).toBeNull();
    expect(point).not.toHaveProperty("observedDate");
  });

  it("fills a missing retailer or quote with an empty string", () => {
    const [point] = pointsFromModelText(
      JSON.stringify([{ ...row, retailer: undefined, quote: 7 }]),
    );
    expect(point.retailer).toBe("");
    expect(point.quote).toBe("");
  });

  it("returns an empty array for prose with no array, an object, or broken JSON", () => {
    expect(pointsFromModelText("I could not find any price history for this product.")).toEqual([]);
    expect(pointsFromModelText('{"price_aud": 2495}')).toEqual([]);
    expect(pointsFromModelText('```json\n[{"price_aud": 2495,\n```')).toEqual([]);
    expect(pointsFromModelText("")).toEqual([]);
  });
});
