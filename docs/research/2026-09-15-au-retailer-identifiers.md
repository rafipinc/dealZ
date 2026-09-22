# AU retailer pages: what identifiers they expose

**Date:** 2026-09-15. **Method:** hand inspection of live product pages. **Reference product:** Samsung 65-inch S90H OLED, model QA65S90HAWXXY.

These findings shaped ADR-0004 (GTIN primary, model code fallback) and ADR-0005 (condition as a strict enum). They are a snapshot; retailer pages change.

## Findings

| Retailer | What the page exposes | Notes |
|---|---|---|
| Harvey Norman | GTIN 8806097948261, Model QA65S90HAWXXY, TV Model S90H, Screen Size 65 | Full structured spec table. Best source found |
| JB Hi-Fi | Model QA65S90HAWXXY, SKU 902831, `og:price` meta tag | SKU is JB-internal. Site is Shopify, so `/products/<handle>.json` should expose `variants[].barcode`. Untested |
| Samsung AU | SKU QA65S90HAWXXY, base code QA65S90HAW on the support page | XXY is the AU regional suffix |
| The Good Guys, Bing Lee, Retravision | Model QA65S90HAWXXY printed verbatim | Model code is consistent across every AU retailer checked |
| Value House | Same model, listed as Factory Second, $3,299 | Same GTIN, different condition. Must not blend into the new-price history |
| Appliance Central | URL slug contains `display-model` and model QA65S90FAEXXY | Different product (S90F, 2025). Condition and year can be inferred from slugs. Titles alone are unreliable |

## Model code anatomy

`QA65S90HAWXXY`: `QA` prefix, `65` size, `S90H` series, `A` revision, `W` panel variant, `XXY` region. A per-brand parser can extract size and series deterministically. Only Samsung has been checked.

## URLs

Retailer URLs carry ad tracking parameters (`gclid`, `gad_source` and others). Listings store a canonical URL with all of it stripped, or the same page gets stored many times.

## What else defines a variant

- **Region.** AU `XXY` versus US `XZA` suffix is a different GTIN, a different warranty story, sometimes a different tuner. Different variant, same product family.
- **Colour and configuration.** Matters more for laptops and phones than TVs. The GTIN handles it, which is another argument for GTIN as primary.
- **Bundles.** No single GTIN. Out of scope for v1.
- **Model year.** S90F (2025) versus S90H (2026). `release_year` lives on the product family.

## Known limitations

- One product examined. The parser and identifier availability need checking across LG, Sony, Apple and laptop brands before the parser is generalised.
- JB Hi-Fi barcode availability through the Shopify JSON endpoint is untested. It is the intended first scraper target (phase 4).
- Condition inference from titles and slugs is heuristic. Confidence is tracked from day one.
- Bundles and grey imports are out of scope for v1.

## Open questions

- Verify the JB Hi-Fi Shopify `barcode` field.
- Pick the first five retailers to cover.
- Check model-code consistency for at least one non-Samsung brand.
