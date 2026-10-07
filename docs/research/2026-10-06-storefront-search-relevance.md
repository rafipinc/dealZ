# Storefront search relevance: five queries on two stores, and why DealZ ranks the results itself

**Date:** 2026-10-06, afternoon. **Method:** one plain HTTPS GET per query per store from a script with a DealZ research User-Agent, no cookies, no browser. **Endpoint:** `/search/suggest.json?q=<query>&resources[type]=product&resources[limit]=20`, the predictive search of the [morning's note](2026-10-06-shopify-storefront-search.md). Twenty results were asked for and ten came back: Shopify caps predictive search at 10. **Stores:** JB Hi-Fi and Powerland, the two searchable storefronts.

This note is the field work behind item 12 of [ADR-0016](../adr/0016-catalogue-discovery-through-storefront-search.md), the relevance rule in `src/lib/relevance.ts`. Rafi searched "Xbox" in the lab and got accessories and unrelated products. He asked for the search to be made effective and relevant, tried on five products: Xbox Series S, Xbox Series X, TV models, and something random such as a DVD player. It is a snapshot; storefronts change.

## Findings

| Query | JB Hi-Fi returned (10) | Powerland returned |
|---|---|---|
| `Xbox Series S` | 2 Series S consoles, 2 Series X consoles, a lighting stand for Series X, a Lexar SSD, an ASUS ROG Xbox Ally, a Lenovo Legion Go S, a PS5, a Seagate Xbox hard drive | 10 Samsung and Hisense TVs and soundbars, nothing to do with Xbox |
| `Xbox Series X` | 2 Series X consoles, 2 Series S consoles, then controllers, a racing wheel and charging stands "for Xbox Series X/S" | 10 soundbars and TVs |
| `Samsung S90H 65` | The 65" S90H first, then the S90H in 83, 77, 55, 48 and 42 inches, then other 65" Samsung models (R95H, The Frame Pro, M70H) and a 100" M90H | 65" Samsung TVs of other series, a soundbar, a TCL, and the 55" S90D and S90F. Powerland does not stock the S90H |
| `Sony Bravia 8 55` | "Sony 55" BRAVIA 8 II" first, then other 55" Bravias, a 65" Bravia 8 II, a 32" W830K, a "BRAVIA Theatre Sub 8" | 1 product: a Samsung 55" QN80H |
| `DVD player` | 10 DVD players, all relevant | 10 TVs, nothing relevant |

Eight of the ten responses are recorded in `src/sources/fixtures/` as `<store>-suggest-<query>.json`: all five on JB Hi-Fi, and Xbox Series S, Samsung S90H 65 and DVD player on Powerland. The relevance tests replay them.

A second request per query asked each store to match on title and vendor only, with `resources[options][fields]=title,vendor,product_type,variants.sku,variants.barcode`. Neither store's answer changed.

## Conclusions

- Predictive search matches any query word anywhere, the description included. "Xbox Series S" returns a PS5 and a Lenovo handheld.
- A store with nothing to say still returns ten products. Powerland answers "DVD player" with ten TVs.
- Restricting the fields the store matches on changes nothing on either store.
- The limit is 10 whatever is asked.
- So relevance has to be decided by DealZ, from the title. The rule is ADR-0016 item 12.

## What the rule makes of these

Verified against the recorded responses by `src/lib/relevance.test.ts`. "Hidden" is a partial or unrelated row, shown under "Other results the stores returned". Where no response was recorded, the figure is expected from the titles seen and marked so.

| Query | JB Hi-Fi | Powerland |
|---|---|---|
| `Xbox Series S` | 2 matches, 8 hidden | 10 hidden |
| `Xbox Series X` | 2 matches, 6 accessories, 2 hidden | 10 hidden (expected, not recorded) |
| `Samsung S90H 65` | 1 match, 9 hidden | 10 hidden |
| `Sony Bravia 8 55` | 1 match, 9 hidden | 1 hidden (expected, not recorded) |
| `DVD player` | 10 matches | 10 hidden |

## Open questions

- A second page of results. Predictive search has none; ten is the ceiling per store per query.
- Whether `product_type` is reliable enough to filter categories. JB Hi-Fi's `GAMES HARDWARE` against `VISUAL` looked useful, with `IT` for drives; Powerland's types differ. Unverified.
- Grouping the same product across stores by model code or GTIN, so one product is one row with a price per store. The next relevance step.
