# End-to-end journeys

The registry that end-to-end coverage is measured against. One row per thing a user can do in the product. `scripts/check-e2e-coverage.mjs` reads this file in CI and fails the build when it disagrees with the spec files.

| Status | Meaning | Spec must exist |
|---|---|---|
| `planned` | Feature not built yet | No, and CI fails if one does |
| `required` | Feature shipped; spec must exist and pass | Yes |
| `covered` | Spec passes in CI | Yes |
| `retired` | Feature removed | No; the spec is deleted |

A journey is added when its feature is designed, before it is built. It is never deleted; it is retired. The Spec column is a filename inside `e2e/`, and the file's top-level `test.describe` title starts with the ID.

| ID | Journey | Actor | Phase | Status | Spec |
|---|---|---|---|---|---|
| J-001 | Sign in as the admin | admin | 2 | planned | |
| J-002 | Create a product, a variant and its identifiers | admin | 2 | planned | |
| J-003 | Add a listing for a variant at a retailer and record a price | admin | 2 | planned | |
| J-004 | Draft a deal from an observation, then publish it | admin | 2 | planned | |
| J-005 | Retract a published deal; price history is untouched | admin | 2 | planned | |
| J-006 | Correct a bad observation by superseding it; history shows the correction | admin | 2 | planned | |
| J-007 | Open the deals feed and see published deals newest first | visitor | 3 | planned | |
| J-008 | Open a product page and see price history per condition | visitor | 3 | planned | |
| J-009 | Search for a product by name or model code | visitor | 3 | planned | |
| J-010 | Read a deal and follow the retailer link | visitor | 3 | planned | |
| J-011 | Read price history through `/api/v1/variants/{id}/price-history` | api client | 3 | planned | |
| J-012 | An unmatched scraped page is staged and confirmed by hand | admin | 4 | planned | |
| J-013 | Open a product page and see whether the current price is good against its history and RRP | visitor | 3 | planned | |
