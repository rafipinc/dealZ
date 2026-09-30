# Live price fetch for the Samsung 65-inch S85H: what each AU retailer exposes

**Date:** 2026-09-28. **Method:** plain HTTP requests from a script, no browser, no cookies, one request per page. **Reference product:** Samsung 65-inch OLED S85H 4K Smart AI TV (2026), model QA65S85HAEXXY.

This note is the field work behind ADR-0012 and the first live fetch in the lab page. It is a snapshot; retailer pages change.

## Findings

| Retailer | Reachable by script | Structured data on the page | Price seen | Struck-through price | Identifiers exposed |
|---|---|---|---|---|---|
| JB Hi-Fi | Yes | Shopify product JSON at `/products/<handle>.json`, plus a JSON-LD `Product` in the HTML | $2,795.00 | $3,295.00 (`compare_at_price`) | `barcode` 8806097962670, SKU 902825 |
| The Good Guys | Yes | JSON-LD `Product` with `offers`, `priceSpecification` of type `StrikethroughPrice`, `gtin`, `model` | $2,795.00 | $3,295.00 | `gtin` 8806097962670, SKU 50098484, model QA65S85HAEXXY |
| Samsung AU | Yes | JSON-LD `Product` with `offers`; list price only in an inline script (`digitalData.product.list_price`) | $2,799 | $3,299 (list price) | SKU QA65S85HAEXXY |
| Harvey Norman | No | Not seen. The response is an Imperva "Pardon Our Interruption" challenge page | | | |
| Bing Lee | No | Not seen. DataDome answers 403 with a challenge page | | | |

Three of five pages are readable with one plain request and expose the price as structured data. The two that are not sit behind bot protection. DealZ does not work around bot protection (ARCHITECTURE.md section 9), so those retailers are recorded as not fetchable until a permitted source exists.

## What this confirms from the 2026-09-15 note

- The JB Hi-Fi Shopify `barcode` field is real and carries the GTIN. That open question is closed.
- The GTIN is a 13-digit EAN, 8806097962670, and passes the check digit as the 14-digit form 08806097962670. JB Hi-Fi and The Good Guys agree on it.
- The model code suffix differs from the S90H note: the S85H is `QA65S85HAE XXY` (revision `A`, panel `E`), not `AW`. The per-brand parser must not assume `W`.

## robots.txt

| Site | Product page rule for `User-agent: *` |
|---|---|
| jbhifi.com.au | `/products/` allowed except gift cards and extra care |
| thegoodguys.com.au | `/products/` disallowed; the product page lives at the site root and is allowed. The Shopify `.json` path is therefore not used for The Good Guys |
| samsung.com | Allowed |
| harveynorman.com.au | No rule seen; the site blocks by challenge instead |
| binglee.com.au | Not readable; the site blocks by challenge |

## Two strategies cover the readable pages

| Strategy | Works for | Reads |
|---|---|---|
| `shopify_json` | JB Hi-Fi | `variants[0].price`, `compare_at_price`, `barcode`, `sku`, product `title`; availability from the `InStock` tag |
| `json_ld` | The Good Guys, Samsung AU | `Product.offers.price`, `priceCurrency`, `availability`, `priceSpecification` strikethrough, `gtin*`, `sku`, `mpn`, `model` |

Both return the same `PriceQuote` shape. Samsung's list price is not in the JSON-LD, so the RRP for the variant is recorded by hand from that page.

## Open questions

- Whether a Node fetch keeps working from Vercel's IP ranges; only a local machine was tested.
- Terms of use for JB Hi-Fi, The Good Guys and Samsung AU have not been read for automated access. Required before any scheduled fetching (phase 4).
- Harvey Norman was the best source of structured specifications in the September note. A permitted route to that data is worth asking for.
