# ADR-0019: The free sources answer before the paid one, and the index learns a category, its route and its identifiers

**Status:** Proposed
**Date:** 2026-10-08
**Decider:** Rafi (proposed by Claude). Rafi asked for the review and answered its proposals with "Do everything you suggest" on 2026-10-08. Every item was proposed by Claude.

## Context

On 2026-10-08 Rafi asked Claude to review the data model and the build against the goal of searching products and gathering data cheaply and securely across multiple product types. The review found six things. The schema is category-agnostic but the TV silo lives in code: one seeded collection, the store's raw type label with no DealZ category, a Samsung-only model-code pattern still in the price search, and hyphenated codes unread. The miss path of the search spent a paid Google Shopping call even when the free storefronts would have answered. Cross-store grouping mostly fails because no listing carries a barcode. An all-zero barcode passes the GS1 check digit and would merge unrelated products. Product family uniqueness was case-sensitive while Shopify vendors arrive as `SAMSUNG` or `Samsung`. And Supabase's Data API would expose every `public` table to the anon key with no row level security once a production project exists.

Rafi replied "Do everything you suggest". Everything below was built with tests in one session by subagents under that instruction. One proposal was deferred: listing prices as price observations depends on the `observations` service ([issue #12](https://github.com/rafipinc/dealZ/issues/12)) and is parked in STATUS.md. The Supabase finding is a production procedure, not a design decision, and is recorded in RUNBOOK.md under "Migrate production". The records this builds on are [ADR-0004](0004-gtin-primary-identifier.md), [ADR-0016](0016-catalogue-discovery-through-storefront-search.md) and [ADR-0017](0017-local-search-index.md). The [research note of 2026-10-08](../research/2026-10-08-powerland-collections.md) holds the collection probe behind item 6.

## Decision

Proposed by Claude, stated so each item can be checked against the code:

1. **The search's miss path is a ladder.** This amends ADR-0017 item 11. `discoverProducts` in `src/services/discovery.ts` searches the index first. When it holds too little, the storefronts are asked, their answers are remembered in the index, and the index is searched again. Google Shopping is asked only when the index is still short, under the unchanged gates of ADR-0017 item 11: a key, a readable budget and the daily cap. A paid call skipped because the storefronts answered reports `storefronts_sufficient`, and the budget is not read when it is skipped for that reason. The index is searched a third time only when Google returned candidates.
2. **A placeholder is not a GTIN.** Fourteen digits of one repeated digit are rejected. All zeros is what a store prints when it has no barcode, and zeros and fives both pass the GS1 check digit. `normaliseGtin` in `lib/gtin` returns null for them, and the checks `identifier_gtin_not_placeholder` and `catalogue_candidate_gtin_not_placeholder` refuse them, so one placeholder can never merge products in the catalogue or the index.
3. **A product family is one row whatever its casing.** The unique index `product_brand_series_year_ci_uq` on `lower(brand)`, `lower(series)` and `coalesce(release_year, 0)` replaces the constraint `product_brand_series_year_uq`. `product.category` is a slug, enforced by `product_category_format`. `normaliseBrand` in `lib/brand` gives a brand its one casing for "Add to catalogue" ([issue #10](https://github.com/rafipinc/dealZ/issues/10)) and is not yet wired to a service.
4. **The index carries DealZ's own category, the route an offer came by, the seller's name and when its product JSON was read.** Four columns on `catalogue_candidate`. `category` is a slug from `lib/category`, checked by `catalogue_candidate_category_format`, and is mapped by `categoryOf` from a seeded collection's hint, else the store's type label, else its tags, else rules on the title; the store's own label stays in `store_type`. `via` is `storefront` or `google_shopping`, checked by `catalogue_candidate_via_known`, and replaces reading `raw` to tell a Google row. `retailer_name` is the seller as Google Shopping printed it, or the store's name. `inspected_at` is when the row's product JSON was read. On upsert a category, a name or an inspection once known is kept; `via` takes the new row's value. Migration `0006_review-refinements` adds them, generated, with one backfill statement appended for `via`. The dropdown shows the category and how long ago the product was seen.
5. **Identifiers are read in bulk, bounded.** `enrichIndex` in the discovery service reads the product JSON of index rows that have no GTIN, were never inspected and came by `storefront` from a searchable storefront, newest sighting first: 25 rows a run by default, at most 100 (`MAX_ENRICH_LIMIT`), 500 ms apart, each read metered as an inspect is (ADR-0014). Every row read is marked inspected, so a product whose JSON carries no barcode is read once and never again. An "Enrich identifiers" button on the lab page, beside "Refresh index", runs it. This is ADR-0016 item 6's lazy read, made batchable. It is J-019 in the journey registry.
6. **Three seeded collections.** Powerland's `hifi-soundbars` (category `soundbar`, 92 listed on 2026-10-08) and `vacuums` (`vacuum`, 172 listed) join `televisions` (`tv`) in `seededCollections` in `src/services/tracked-products.ts`. Each collection's category is the hint of item 4. Vacuums is the first collection outside the consumer-tech wedge of [ADR-0002](0002-consumer-tech-wedge.md), kept to exercise the category mapper on a second product type. Rafi may drop it.
7. **One model-code rule.** The general rule of `lib/model-code` replaces the Samsung-only pattern in the price search, `isCandidate` in `src/sources/serpapi.ts`. This fulfils ADR-0016 item 11. A hyphenated code in one narrow form, 2 to 4 letters, a hyphen and a code (`XR-65A95L`, `HW-Q990H`), is read as printed. `normaliseModelCode` gives the form compared across stores: upper-cased, with hyphens and spaces removed. The search's store verification compares that form, so a hyphen in one store's title and not another's no longer splits a product.

## Options rejected

- **Asking the storefronts and Google Shopping together on a miss.** Spends a paid call on products the stores stock.
- **A `category` table now.** The list in `lib/category` serves until the public pages need navigation, phase 3.
- **A `retailer_collection` table now.** Waits for the `retailers` service ([issue #10](https://github.com/rafipinc/dealZ/issues/10)).
- **Reading identifiers for every candidate on every search.** One request per candidate per search: latency, and the terms question on each.
- **Wiping the index instead of backfilling `via`.** One statement does it, and the index is disposable anyway (ADR-0017 item 9).
- **Per-brand model-code parsers.** ADR-0004's plan. The general rule with one narrow hyphenated form covers every store seen.
- **Listing prices as price observations now.** Needs the `observations` service ([issue #12](https://github.com/rafipinc/dealZ/issues/12)). Parked in STATUS.md.

## Consequences

- A seventh migration, `0006_review-refinements`, and rows in DATA_MODEL.md for the four new checks and the replaced unique index; TESTING.md's matrix follows. Both are updated in the second documentation pass.
- ADR-0017's status line points here for item 11.
- ARCHITECTURE.md section 4's rows for `discovery` and `catalogue-index` gain the ladder and `enrichIndex`, in the second pass.
- J-019 is in the journey registry: developer, phase 1, planned, hidden in PUBLIC.md as a lab page.
- The blocklist gains no term: no new retailer, provider or technique.
- Revisit when the daily cap is reached on an ordinary day, when issue #10 wires the brand normaliser, when issue #12 can take listing prices as observations, and when a category needs navigation.
