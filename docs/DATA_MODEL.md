# DealZ Data Model

**Status:** accepted 2026-09-17, updated 2026-10-08 (`catalogue_candidate`, ADR-0017, accepted 2026-10-08; placeholder GTINs, case-insensitive product families and the `catalogue_candidate` enrich columns, [ADR-0019](adr/0019-free-sources-first-index-learns-category.md), proposed 2026-10-08).
**Source of truth:** [`src/db/schema.ts`](../src/db/schema.ts), [`src/db/sql/triggers.sql`](../src/db/sql/triggers.sql), for `api_usage` [`src/db/sql/api-usage-triggers.sql`](../src/db/sql/api-usage-triggers.sql) and for `catalogue_candidate` [`src/db/sql/catalogue-candidate-search.sql`](../src/db/sql/catalogue-candidate-search.sql). This document explains the shape; the code defines it.

## Principles

1. Data is the product. Everything else is a view over it.
2. Price history hangs off a variant (a physical SKU), never a product family.
3. Facts and opinions are separate tables. `price_observation` is a fact. `deal` is an opinion about a fact.
4. Facts are never rewritten. `price_observation` is append-only, enforced by a trigger. Corrections supersede; they do not overwrite.
5. Matching never merges variants on low confidence. A missed match is recoverable; a wrong merge poisons price history.
6. Every invariant Postgres can enforce, it enforces. Application code is the second line of defence.

## Shape

```
retailer ─────────────────┐
                          ├──< listing ──< price_observation ──< deal
product ──< variant ──────┘                     │
              │                      supersedes ┘ (self-reference)
              └──< identifier
```

`A ──< B` reads "one A, many B".

## Tables

### retailer
One row per shop. `slug` and `domain` are unique. `platform` (shopify, magento, custom) is a hint for choosing a scraper strategy later.

### product
A product family: Samsung, S90H, tv, 2026. Never carries a price. `slug` is its public URL segment. Unique on brand and series ignoring case, and on release year with null counted as one value, so `SAMSUNG` and `Samsung` are one family and two "S90H, unknown year" rows cannot coexist (ADR-0019 item 3). `category` is a DealZ category slug from `src/lib/category.ts`, never a store's label. `image_url` is the family hero image.

### variant
One physical SKU within a family: the 65-inch AU S90H. `slug` is unique within the product. `region` (ISO 3166-1 alpha-2) is part of identity because AU and US units have different GTINs. `rrp_cents` is the manufacturer's recommended price when known, the first reference point for "is this a good price". `attributes` (jsonb) holds anything category-specific without schema churn.

### identifier
Maps external identifiers to a variant. `type` is `gtin`, `mpn` (manufacturer model code, e.g. QA65S90HAWXXY) or `retailer_sku`. `retailer_id` is required for `retailer_sku` and must be null otherwise. Unique on type, value and retailer with nulls treated as equal, which is what makes a GTIN or MPN map to at most one variant. GTINs are stored as 14 digits; the service normalises shorter forms and validates the check digit before insert. A value of one repeated digit, such as all zeros, passes the check digit but is the placeholder a store prints when it has no barcode; the database rejects it, since one placeholder shared by many products would merge them (ADR-0019 item 2).

### listing
One retailer page for one variant. A row here means the match is confirmed. `canonical_url` has tracking parameters stripped and is unique per retailer. `condition` defaults to `unknown`, and `unknown` is excluded from "best price" until confirmed. `match_method`, `match_confidence` and `matched_at` record how the page was linked to its variant (ADR-0010). `first_seen_at`, `last_seen_at` and `is_active` track whether the page still exists.

Condition values: `new`, `refurbished_manufacturer`, `refurbished_seller`, `factory_second`, `display_model`, `open_box`, `used`, `unknown`.

### price_observation
One price seen on one listing at one time. `price_cents` integer, `currency` ISO 4217 (AUD in v1). `source` is `manual`, `scrape` or `api`. `confidence` is how sure the parser was. `raw` keeps the scraper's input so a bad parse can be replayed without refetching. `supersedes_id` points at the observation this row corrects (ADR-0009). Append-only.

### deal
An editorial call: this observation is worth telling people about. References the `price_observation` only; listing, variant and product are reached through it, so a deal can never disagree with its observation about which listing it is on. Has its own lifecycle (`draft`, `published`, `expired`, `retracted`) and its own text. Retracting a deal never touches price history.

### api_usage
The usage ledger: one row per outbound call to an external service ([ADR-0014](adr/0014-usage-ledger-and-status-dashboard.md), accepted 2026-10-02). It sits outside the catalogue shape above and has no foreign keys. `provider` is an open set (`serpapi`, `gemini`, `openai`, `wayback`, `retailer`), so it is text with a slug check. `outcome` is `ok` or `failed`; a failed row carries the source's `error_kind`. `cost_micros` is the estimated cost in millionths of a US dollar, computed by the service at write time from the price in force when the call started. A stored zero does not say whether a call was free or unpriced; that is decided at read time from the price table, so no column holds it. It is the one exception to integer cents, because a single Gemini call costs a fraction of a cent. `retailer_slug` and `variant_slug` are text, not foreign keys: the tracked products are not rows yet. Append-only. It never holds an API key or a request URL.

### catalogue_candidate
The local search index: one row per product a retailer storefront has shown DealZ, from a listing pull or a live search ([ADR-0017](adr/0017-local-search-index.md)). It is the staging table [ADR-0010](adr/0010-listing-match-audit-and-staging.md) deferred to phase 4, brought forward. A row is a snapshot of what the store said, never price history: no row here is a `price_observation`, and nothing references the table. The upsert key is `retailer_slug` and `handle`; a repeat sighting replaces the row in place, keeps `first_seen_at` and moves `last_seen_at`, and an identifier once read (`gtin`, `mpn`, `retailer_sku`) is never erased by a sighting that lacks it. `retailer_slug` is text with a slug check, not a foreign key, for the same reason as on `api_usage`. `source` (`listing`, `search`, `inspect`) is text with a check rather than an enum, so a fourth source needs no enum migration. Title search runs on a `pg_trgm` GIN index; the extension and that index live in the hand-written SQL file, since the index cannot precede the extension inside a generated migration. Four columns serve the enrich pass and the Google Shopping rows (ADR-0019 items 4 and 5). `category` is DealZ's category slug for the row, mapped by `src/lib/category.ts`; the store's own label stays in `store_type`. `via` (`storefront`, `google_shopping`) says where the row was read, as a fact of the row rather than something parsed out of `raw`. `retailer_name` is the seller's name as Google Shopping printed it, or the store's name; null when unknown. `inspected_at` is set when the row's product JSON was read; a row inspected once and still without a GTIN has none in its JSON, so an enrich pass never re-reads it. A placeholder GTIN of one repeated digit is rejected here as on `identifier`, since the index groups rows by GTIN and a placeholder would group unrelated products silently. Columns are in [`src/db/schema.ts`](../src/db/schema.ts).

## Invariants and where they live

| Invariant | Enforced by |
|---|---|
| Observations are never updated or deleted | trigger `price_observation_append_only` |
| A correction supersedes an observation on the same listing | foreign key, plus trigger `price_observation_supersedes_same_listing` |
| A GTIN or MPN belongs to at most one variant | unique `identifier_type_value_retailer_uq` (NULLS NOT DISTINCT) |
| GTINs are 14 digits | check `identifier_gtin_is_14_digits`; check digit validated in `lib/gtin` |
| A GTIN is never a placeholder of one repeated digit | check `identifier_gtin_not_placeholder` |
| Retailer SKUs carry a retailer, global identifiers do not | check `identifier_retailer_only_for_sku` |
| One listing per retailer page | unique `listing_retailer_url_uq` |
| Product families are unique by brand, series, year, ignoring case | unique index `product_brand_series_year_ci_uq` on `lower(brand)`, `lower(series)`, `coalesce(release_year, 0)` |
| A product's category is a slug | check `product_category_format` |
| Variant slugs are unique within a product | unique `variant_product_slug_uq` |
| Slugs are URL-safe; regions and currencies are ISO codes | check constraints on each column |
| Confidence values lie in 0..1; prices and RRPs are non-negative | check constraints |
| A published deal has a `published_at` | check `deal_published_has_timestamp` |
| `updated_at` is always current | trigger `set_updated_at` on every mutable table |
| History cannot be orphaned | `ON DELETE RESTRICT` from listing down to deal |
| Usage ledger rows are never updated or deleted | trigger `api_usage_append_only` |
| A usage provider is a slug | check `api_usage_provider_format` |
| A call outcome is `ok` or `failed` | enum `api_call_outcome` |
| A failed call names its error kind, an ok call has none | check `api_usage_error_kind_only_when_failed` |
| Call durations, token counts and costs are non-negative | checks `api_usage_duration_non_negative`, `api_usage_input_tokens_non_negative`, `api_usage_output_tokens_non_negative`, `api_usage_cost_non_negative` |
| One candidate per product per store | unique `catalogue_candidate_retailer_handle_uq` |
| A candidate's retailer is a slug | check `catalogue_candidate_retailer_slug_format` |
| A candidate's GTIN, when present, is 14 digits | check `catalogue_candidate_gtin_is_14_digits` |
| A candidate's GTIN is never a placeholder of one repeated digit | check `catalogue_candidate_gtin_not_placeholder` |
| Candidate prices are non-negative | checks `catalogue_candidate_price_non_negative`, `catalogue_candidate_compare_at_non_negative` |
| A candidate's currency is an ISO 4217 code | check `catalogue_candidate_currency_iso4217` |
| A candidate's source is `listing`, `search` or `inspect` | check `catalogue_candidate_source_known` |
| A candidate's category, when present, is a slug | check `catalogue_candidate_category_format` |
| A candidate was read via `storefront` or `google_shopping` | check `catalogue_candidate_via_known` |
| A repeat sighting keeps `first_seen_at`, a stored identifier, category, retailer name and `inspected_at` | `upsertCatalogueCandidates` (ON CONFLICT DO UPDATE with coalesce); not a constraint, tested as one |

## Matching

Ingestion resolves a page to a variant through `identifier`, in trust order:

| Tier | Method | Auto-merge? | Recorded as |
|---|---|---|---|
| 1 | GTIN exact | Yes | `match_method = gtin` |
| 2 | Model code by the one general rule in `lib/model-code`, which reads a hyphenated code in one narrow form, compared through `normaliseModelCode` (ADR-0019 item 7) | Yes | `mpn` |
| 3 | Normalised title match | No: staged for review | `title`, once confirmed |
| 4 | LLM-assisted structured match with a confidence score | No: staged for review | `llm`, once confirmed |

In v1 every listing is entered by hand and recorded as `manual` with confidence 1. Pages the storefronts show that are not yet listings sit in `catalogue_candidate` (ADR-0017), which is the staging table ADR-0010 deferred.

## Corrections

To correct a bad observation, insert a new one with `supersedes_id` set to the bad row. The current observations for a listing are those no row supersedes:

```sql
select o.*
from price_observation o
where o.listing_id = $1
  and not exists (
    select 1 from price_observation c where c.supersedes_id = o.id
  )
order by o.observed_at desc;
```

The original stays in the table for audit. Chains are allowed: a correction can itself be corrected.

## Queries the model is built for

| Question | Path | Served by |
|---|---|---|
| Price history for a variant, by condition | variant → listing → current observations | `listing_variant_idx`, `price_observation_listing_time_idx` |
| Best current price for a variant | Latest current observation per active listing, excluding `unknown` condition, minimum per condition | same |
| Published deals, newest first | deal → observation → listing → variant → product | `deal_status_published_idx` |
| Resolve a scraped identifier | identifier by type and value, plus retailer for SKUs | `identifier_type_value_retailer_uq` |
| Calls and estimated cost per provider over a period | api_usage by provider and time | `api_usage_provider_time_idx` |
| Successful calls per operation for a provider over a period (`countOkCallsByOperation`) | api_usage by provider and time, `outcome = 'ok'`, grouped by `operation` | `api_usage_provider_time_idx` |
| Calls and estimated cost per day and provider, by the calendar days of a time zone (`dailyApiUsage`) | api_usage over a period, bucketed by `called_at` in that zone | `api_usage_time_idx` |
| Calls per day, provider and model, to tell an unpriced call from a free one (`modelCallsByDay`) | same buckets, grouped by model as well | `api_usage_time_idx` |
| Most recent external calls | api_usage newest first | `api_usage_time_idx` |
| Search the index by title (`searchCatalogueCandidates`) | catalogue_candidate by substring of `title` (ILIKE) or trigram similarity above a floor, best match first then most recently seen | `catalogue_candidate_title_trgm_idx` (GIN, `gin_trgm_ops`) serves the ILIKE arm; `similarity(title, q) > 0.1` cannot use it and is computed on the candidate rows for the filter and the ordering |
| Search the index by identifier (`searchCatalogueCandidates`) | catalogue_candidate by exact `gtin`, `mpn` or `retailer_sku` | `catalogue_candidate_gtin_idx`, `catalogue_candidate_mpn_idx`; `retailer_sku` is sequential |
| Write a storefront's products (`upsertCatalogueCandidates`) | catalogue_candidate by retailer and handle | `catalogue_candidate_retailer_handle_uq` |
| Drop what a store no longer lists (`deleteUnseenListingRows`) | catalogue_candidate `listing` rows of one retailer with `last_seen_at` before the refresh began, an instant read from the database's clock by `databaseNow` so it is the clock that stamped the rows | `catalogue_candidate_retailer_handle_uq` (leading column) |
| How big the index is, per retailer (`countCatalogueCandidates`) | catalogue_candidate grouped by `retailer_slug` | sequential; the table is small |
| The rows an enrich pass reads product JSON for (`listCandidatesWithoutGtin`) | catalogue_candidate `storefront` rows of the named retailers with no `gtin` and no `inspected_at`, newest sighting first, at most 100 | `catalogue_candidate_gtin_idx` (`IS NULL` is a btree lookup); the rest is filtered on those rows, and the table is small |

Only the `%` operator and LIKE/ILIKE can use a trigram GIN index. If the table grows enough for the similarity scan to show, the upgrade is the `%` operator with `set_limit()` in place of the explicit floor, which keeps the same ranking and lets the index serve both arms.

When these get slow, the answer is a materialised summary per variant, not a change to the fact table.

## Deliberate omissions (v1)

- Bundles. No single GTIN, skipped.
- Users and auth. `deal.created_by` is free text until phase 2.
- Currency conversion. Everything is AUD in v1; the column exists so history is never ambiguous.
- Stock and availability. A second append-only observation table, added later without changing anything here.
- Staging table for unmatched pages: no longer omitted. It exists as `catalogue_candidate` ([ADR-0017](adr/0017-local-search-index.md)), brought forward from phase 4 as the local search index.
- Variant-level images. Product-level hero image only, until a category with colour variants arrives.
