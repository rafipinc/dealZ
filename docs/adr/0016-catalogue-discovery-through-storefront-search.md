# ADR-0016: Catalogue discovery through retailer storefront search, with a developer dashboard that adds products by confirmation

**Status:** Accepted (2026-10-08)
**Date:** 2026-10-06
**Decider:** Rafi (proposed by Claude). Rafi decided items 1 to 3 in chat on 2026-10-06. Items 4 to 12 were proposed by Claude. Item 12 was added the same day, after Rafi used the search bar. Rafi accepted the record, Claude's proposed items included, on 2026-10-08.

## Context

The catalogue is one row: the tracked TV in the TypeScript table `src/services/tracked-products.ts`. No `catalog`, `retailers` or `listings` service exists, so nothing can be added except by editing that file. On 2026-10-06 Rafi asked for a dashboard, in the same lab UI, where he can search other products by title, model code or anything else a user might use, with a plan for developing the catalogue, for seeing what data is used, and for where the data should come from.

Claude proposed two searches kept apart: catalogue search over our own rows, and discovery search over external sources. It proposed a lab panel whose "Add to catalogue" button becomes the missing persistence, and a source ladder, free first: a Shopify store's own predictive search, then Google Shopping through SerpApi for breadth, then Open Icecat for enrichment, with affiliate feeds unchanged as the long-term route. GS1 and barcode registries were rejected.

Rafi then asked how easily this expands beyond consumer tech to any product, as Google Shopping covers. Claude's answer: the schema, the page sources, SerpApi, Wayback, the model reader and the ledger are category-agnostic already. The silo is the Samsung model-code pattern in the search source, the planned per-brand parser, and the TV vocabulary in the tracked table. The quality limit is identifiers: hard goods with a GTIN or a stable model code expand cheaply; fashion, groceries and bundles do not, and stay staged per [ADR-0010](0010-listing-match-audit-and-staging.md). The eBay Browse API (free keys, searches by GTIN, an AU marketplace) is a strong future second source. Amazon's product API needs three sales before it issues a key.

Before writing, Claude probed three storefronts with one plain request each. The [research note of 2026-10-06](../research/2026-10-06-shopify-storefront-search.md) holds the findings. In short: a title query answers on JB Hi-Fi and Powerland; a GTIN query answers on JB Hi-Fi; a model-code query returns nothing on JB Hi-Fi, whose titles carry no code; Bing Lee is bot-protected and is not searched; the suggest response carries no barcode or SKU, which the product JSON verified on [2026-09-28](../research/2026-09-28-s85h-live-fetch.md) does. The earlier records this builds on are [ADR-0002](0002-consumer-tech-wedge.md), [ADR-0004](0004-gtin-primary-identifier.md), [ADR-0010](0010-listing-match-audit-and-staging.md), [ADR-0012](0012-sources-layer-live-fetch-spike.md) and [ADR-0014](0014-usage-ledger-and-status-dashboard.md).

## Decision

Decided by Rafi:

1. **A catalogue dashboard in the lab, `/lab/catalog`.** Amended by [ADR-0017](0017-local-search-index.md) on 2026-10-06: the dashboard lives on `/lab`. Development-only, like `/lab` and `/lab/status`, with the same table-and-button UI. It searches the catalogue, then discovers products from external sources, and adds a confirmed candidate to the catalogue.
2. **The first discovery source is Shopify storefront predictive search**, on the tracked Shopify retailers that answer scripted requests (JB Hi-Fi, Powerland). Technology products first.
3. **Google Shopping through SerpApi is the second rung of discovery**, in a later change, for products the storefronts do not stock. Not in this change. That change is [ADR-0017](0017-local-search-index.md) items 10 and 11.

Proposed by Claude:

4. **Two searches, kept apart and always run in this order.** Catalogue search first, over product, variant and identifier rows: ILIKE on display name, brand and series, exact match on identifier value. The trigram index stays a phase 3 decision (ARCHITECTURE.md section 11). Note: [ADR-0017](0017-local-search-index.md) item 4 brought a trigram index forward to phase 1 for the local candidate index, the `catalogue_candidate` table. Search over catalogue rows is unchanged by that. Discovery second. A product already held is shown as held, never as a new candidate.
5. **A second output type in the sources layer.** A discovery source takes one query and returns `ProductCandidate`s: title, brand as the store names it, retailer, page URL, handle, the price and compare-at price seen, availability, image URL, identifiers when known, provenance, `fetchedAt` and `raw`. It is not a `PriceQuote`: a candidate carries no observed price fact to persist. The rules of ADR-0012 apply unchanged: `src/lib` only, injected `fetch`, `SourceError`, bot protection respected.
6. **Identifiers are fetched lazily.** The suggest response carries no barcode or SKU. The product JSON is requested only for a candidate the developer inspects or adds, one request per candidate, read by the existing `shopify_json` reader.
7. **Query routing in a `discovery` service.** A query of 8 to 14 digits is a GTIN: normalised to 14 digits and validated by `lib/gtin`, matched exactly against the catalogue, and sent as the barcode to the storefronts. Anything else is sent as text. A model-code query is text; a store whose titles hold no model code returns nothing and the next source is tried. Every storefront request is metered (ADR-0014), provider `retailer`, with a new operation `search` beside `page`.
8. **Adding is a confirmed action.** Nothing is created from a search alone. The add form shows the candidate's fields, with brand, series, category, release year, size and region editable, and the developer confirms. The `catalog` and `retailers` services create the product (if its family is new), the variant, its identifiers (GTIN; MPN when the title or product JSON carries one; retailer SKU with the retailer row) and the retailer. The listing row follows when the `listings` service exists; until then the dashboard says the page is not yet a listing. Match method `manual`, confidence 1, per ADR-0010.
9. **The dashboard shows what data is used.** Per candidate, which source produced each field. For the catalogue, coverage counts: variants with a GTIN, an MPN, an RRP, an image and a listing.
10. **The hand-maintained tracked table is replaced by rows once `catalog` exists.** The one tracked TV is seeded through the services, `/lab` reads the rows, and `src/services/tracked-products.ts` is deleted.
11. **Expansion rule.** The search source's Samsung-only model-code check becomes a general rule, that the tokens a candidate itself exposes must appear, when the SerpApi rung is added. Categories expand where products carry a GTIN or a stable model code. Categories without them get tiers 3 and 4 only and are staged (ADR-0010).
12. **Relevance is decided by DealZ, from the title.** Added on 2026-10-06 after Rafi's search for "Xbox" returned accessories and unrelated products; the [second research note of 2026-10-06](../research/2026-10-06-storefront-search-relevance.md) holds the probes. Predictive search matches any query word anywhere, the description included, and a store with nothing to say still returns ten products. The rule is a pure function in `src/lib/relevance.ts`, tested against the recorded responses. Title and brand are tokenised: a trailing possessive is stripped, then the text is lower-cased and split on anything that is not a letter or digit, so `65"` is `65` and `X/S` is `x` and `s`. Four tiers. `match`: every query token appears in the title or brand. `accessory`: every token appears, but the title names the product as what the item is for, with `for` before the first query word in the title, or carries an accessory word (controller, stand, charger, case, cable and their kind) that the query itself lacks. `partial`: at least one token of three or more characters appears, or half the tokens. `unrelated`: otherwise. A score orders rows within a tier: a bonus when the query appears as a phrase, in order and adjacent, one point per token matched, a tenth off per extra title word, never below zero. A GTIN query bypasses the rule: the store matched the barcode, so every candidate is a match. The `discovery` service sorts each store's candidates by tier, then score, then title under the `en` collation whatever the host's locale, and reports the tier counts. The lab panel shows match rows, then accessory rows with a badge, and hides partial and unrelated rows under "Other results the stores returned (N)" with the tier and reason per row, for example "partial · missing: 65". When no row is a match or an accessory it says "No product matched every word." Named false positives: order and gaps are ignored, so "Sony Bravia 8" matches "Bravia 8 II" and "BRAVIA Theatre Sub 8", and "Series X Xbox" matches "Xbox Series X"; a stray one-letter token other than a trailing possessive still counts as a word. Named false negatives: `for` earlier in a title for another reason; `remote` or `drive` inside a product's own title; a console bundled with a controller reads as an accessory.

## Options rejected

- **SerpApi as the first discovery rung.** Quota, no GTIN in its results, and the storefront answers a GTIN query free.
- **Open Icecat as a discovery source.** Lookup by identifier only, and registration needed. Enrichment later.
- **Paginating `/collections/all/products.json` for whole catalogues.** Thousands of requests, closer to crawling, a phase 4 and terms-of-use question. Note: ADR-0017 item 2 pulls one seeded collection, not a whole catalogue; this rejection stands for whole catalogues.
- **Building the phase 2 admin flow (J-002) now.** Pulls authentication forward.
- **Creating rows automatically from a search.** A wrong family poisons history. ADR-0010's rule, applied to the catalogue.
- **The eBay Browse API now.** Needs developer keys and OAuth. A candidate second rung after SerpApi.
- **A general product-search framework for every category now.** Quality follows identifiers. ADR-0002 stands.
- **Asking the store to match on title and vendor only.** Verified on 2026-10-06 to change nothing on either store.
- **Filtering by the store's product type.** Types differ per store and are unverified; kept as an open question.

## Consequences

- The sources layer has two output types, `PriceQuote` and `ProductCandidate`, and ARCHITECTURE.md section 3 says so. `SourceOperation` gains the value `search`.
- The `discovery` service has a row in ARCHITECTURE.md section 4, planned, and `catalog` gains `searchCatalog`.
- The Product search open decision in section 11 is partly settled: ILIKE now, the trigram index in phase 3. Note: ADR-0017 settles it, with a trigram index on the local candidate table in phase 1; catalogue rows keep ILIKE.
- The tracked table is removed in step (f) below. J-017 is in the journey registry. C-027 to C-029 are in BUILD_MAP.md. The blocklist gains the technique and two providers.
- Terms of use for the search endpoint are the same open question as for the pages (STATUS.md).
- The build order, one session each. (a) and (c) are independent.

| Step | Change |
|---|---|
| (a) | PGlite invariant tests for `product`, `variant` and `identifier` |
| (b) | `retailers` and `catalog` services with `searchCatalog`, seeding the tracked TV |
| (c) | The `storefront_search` discovery source (`src/sources/storefront-search.ts`) and the `discovery` service |
| (d) | The `/lab/catalog` page and its actions. Note: on `/lab`, per ADR-0017 item 3 |
| (e) | The `listings` service and the listing row on add |
| (f) | `/lab` reads rows; the tracked table is deleted |

- Revisit when the SerpApi rung is added: the general verification rule of item 11, and whether a second storefront family is worth a source of its own.
