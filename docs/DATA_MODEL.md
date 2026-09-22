# DealZ Data Model

**Status:** accepted 2026-09-17.
**Source of truth:** [`src/db/schema.ts`](../src/db/schema.ts) and [`src/db/sql/triggers.sql`](../src/db/sql/triggers.sql). This document explains the shape; the code defines it.

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
A product family: Samsung, S90H, tv, 2026. Never carries a price. `slug` is its public URL segment. Unique on brand, series and release year, with nulls treated as equal so two "S90H, unknown year" rows cannot coexist. `image_url` is the family hero image.

### variant
One physical SKU within a family: the 65-inch AU S90H. `slug` is unique within the product. `region` (ISO 3166-1 alpha-2) is part of identity because AU and US units have different GTINs. `rrp_cents` is the manufacturer's recommended price when known, the first reference point for "is this a good price". `attributes` (jsonb) holds anything category-specific without schema churn.

### identifier
Maps external identifiers to a variant. `type` is `gtin`, `mpn` (manufacturer model code, e.g. QA65S90HAWXXY) or `retailer_sku`. `retailer_id` is required for `retailer_sku` and must be null otherwise. Unique on type, value and retailer with nulls treated as equal, which is what makes a GTIN or MPN map to at most one variant. GTINs are stored as 14 digits; the service normalises shorter forms and validates the check digit before insert.

### listing
One retailer page for one variant. A row here means the match is confirmed. `canonical_url` has tracking parameters stripped and is unique per retailer. `condition` defaults to `unknown`, and `unknown` is excluded from "best price" until confirmed. `match_method`, `match_confidence` and `matched_at` record how the page was linked to its variant (ADR-0010). `first_seen_at`, `last_seen_at` and `is_active` track whether the page still exists.

Condition values: `new`, `refurbished_manufacturer`, `refurbished_seller`, `factory_second`, `display_model`, `open_box`, `used`, `unknown`.

### price_observation
One price seen on one listing at one time. `price_cents` integer, `currency` ISO 4217 (AUD in v1). `source` is `manual`, `scrape` or `api`. `confidence` is how sure the parser was. `raw` keeps the scraper's input so a bad parse can be replayed without refetching. `supersedes_id` points at the observation this row corrects (ADR-0009). Append-only.

### deal
An editorial call: this observation is worth telling people about. References the `price_observation` only; listing, variant and product are reached through it, so a deal can never disagree with its observation about which listing it is on. Has its own lifecycle (`draft`, `published`, `expired`, `retracted`) and its own text. Retracting a deal never touches price history.

## Invariants and where they live

| Invariant | Enforced by |
|---|---|
| Observations are never updated or deleted | trigger `price_observation_append_only` |
| A correction supersedes an observation on the same listing | foreign key, plus trigger `price_observation_supersedes_same_listing` |
| A GTIN or MPN belongs to at most one variant | unique `identifier_type_value_retailer_uq` (NULLS NOT DISTINCT) |
| GTINs are 14 digits | check `identifier_gtin_is_14_digits`; check digit validated in `lib/gtin` |
| Retailer SKUs carry a retailer, global identifiers do not | check `identifier_retailer_only_for_sku` |
| One listing per retailer page | unique `listing_retailer_url_uq` |
| Product families are unique by brand, series, year | unique `product_brand_series_year_uq` (NULLS NOT DISTINCT) |
| Variant slugs are unique within a product | unique `variant_product_slug_uq` |
| Slugs are URL-safe; regions and currencies are ISO codes | check constraints on each column |
| Confidence values lie in 0..1; prices and RRPs are non-negative | check constraints |
| A published deal has a `published_at` | check `deal_published_has_timestamp` |
| `updated_at` is always current | trigger `set_updated_at` on every mutable table |
| History cannot be orphaned | `ON DELETE RESTRICT` from listing down to deal |

## Matching

Ingestion resolves a page to a variant through `identifier`, in trust order:

| Tier | Method | Auto-merge? | Recorded as |
|---|---|---|---|
| 1 | GTIN exact | Yes | `match_method = gtin` |
| 2 | Model code via per-brand deterministic parser | Yes | `mpn` |
| 3 | Normalised title match | No: staged for review | `title`, once confirmed |
| 4 | LLM-assisted structured match with a confidence score | No: staged for review | `llm`, once confirmed |

In v1 every listing is entered by hand and recorded as `manual` with confidence 1. The staging table for unmatched pages is designed with the first scraper (phase 4).

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

When these get slow, the answer is a materialised summary per variant, not a change to the fact table.

## Deliberate omissions (v1)

- Bundles. No single GTIN, skipped.
- Users and auth. `deal.created_by` is free text until phase 2.
- Currency conversion. Everything is AUD in v1; the column exists so history is never ambiguous.
- Stock and availability. A second append-only observation table, added later without changing anything here.
- Staging table for unmatched pages. Designed with the first scraper.
- Variant-level images. Product-level hero image only, until a category with colour variants arrives.
