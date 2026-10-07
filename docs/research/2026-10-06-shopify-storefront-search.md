# Shopify storefront search on AU retailers: what a predictive-search query returns

**Date:** 2026-10-06. **Method:** one plain HTTPS GET per query from a script with a DealZ research User-Agent, no cookies, no browser. **Endpoint:** `/search/suggest.json?q=<query>&resources[type]=product&resources[limit]=N`, Shopify's predictive search, no key. **Reference product:** the Samsung 65-inch S85H of the [2026-09-28 note](2026-09-28-s85h-live-fetch.md), GTIN 8806097962670, model QA65S85HAEXXY.

This note is the field work behind [ADR-0016](../adr/0016-catalogue-discovery-through-storefront-search.md). It is a snapshot; storefronts change.

## Findings

| Store | Query | Status | Result |
|---|---|---|---|
| JB Hi-Fi (jbhifi.com.au) | `LG C5 65` | 200 | 10 products, all LG TVs: 65" C6, G6, B6, QNED70B, QNED90B, QNED86B, 55" C6, 77" C6, 65" Objet Collection Easel (2022), 83" C6. No C5 in the ten |
| JB Hi-Fi | `QA65S85HAEXXY` (model code) | 200 | 0 products. JB Hi-Fi titles carry no model code and the index does not match it |
| JB Hi-Fi | `8806097962670` (the S85H GTIN) | 200 | 1 product: Samsung 65" S85H OLED 4K Smart AI TV [2026], $2,795.00, compare-at $3,295.00. The barcode is indexed |
| Powerland (powerland.com.au) | `LG C5 65` | 200 | 5 products. Titles end with the model code, for example `LG 65" AI B6 4K Smart OLED TV 2026 OLED65B6PSA`, and TCL 65C7L, 65C6L |
| Bing Lee (binglee.com.au) | `LG C5 65` | 403 | DataDome challenge page, the same as its product pages. Not searched |

## What a suggest product carries

| Field | Seen |
|---|---|
| `title` | The display title |
| `vendor` | The brand as the store names it: `LG`, `SAMSUNG` |
| `type` | JB Hi-Fi: `VISUAL`. Powerland: `OLED`, `4K QNED TV` |
| `handle`, `url` | The product page |
| `price`, `price_min`, `price_max` | The price seen |
| `compare_at_price_min`, `compare_at_price_max` | The struck-through price, `0.00` when none |
| `available` | Boolean |
| `tags` | JB Hi-Fi: `Brand:Lg`, `InStock`, `LimitedStock` |
| `featured_image`, `image` | Image URLs |
| `body` | A long HTML description |
| `variants` | An empty array |

The suggest response carries no barcode and no SKU. A second request to `/products/<handle>.json` returns them. For the JB Hi-Fi LG 65" C6, handle `lg-65-oled-evo-ai-c6-4k-smart-tv-2026`: product type VISUAL, SKU 891999, barcode 8806096673584, price 3266.00, compare-at price 3995.00, 12 images, tags `Brand:Lg, InStock`. That endpoint and its `barcode` were verified on 2026-09-28 for the S85H.

## Conclusions

- A GTIN query works on JB Hi-Fi.
- A model-code query does not work on JB Hi-Fi. It should work on Powerland, whose titles hold the code. Expected, not verified: Powerland was not queried by model code on 2026-10-06.
- A title query works on both.
- Identifiers cost one more request per candidate. They are fetched only for a candidate the developer inspects or adds.
- Bot-protected stores are not searched, the same rule as for pages (ADR-0012 item 5).

## Open questions

- Terms of use for the search endpoint, the same question as for the pages (STATUS.md).
- Whether `type` and `tags` are stable enough to filter to technology products.
- Whether LG, TCL and other brands' model codes appear in titles consistently enough for a general verification rule.
- `/collections/all/products.json` with pagination as a whole-catalogue route was not probed. It is closer to crawling and is a phase 4 question.
