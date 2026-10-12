# Powerland collections: what the collection list says, and why its counts overstate a pull

**Date:** 2026-10-08. **Method:** one plain HTTPS GET per endpoint from a script with the DealZ research User-Agent, no cookies, no browser. **Endpoints:** `/collections.json?limit=250` and `/collections/<handle>/products.json?limit=250&page=1`, the listing endpoints of the [2026-10-06 note](2026-10-06-storefront-listings-and-latency.md). **Store:** Powerland, the one seeded storefront.

This note is the field work behind items 4 and 6 of [ADR-0019](../adr/0019-free-sources-first-index-learns-category.md): a second and a third seeded collection, each with a category hint. It closes the open question of the 2026-10-06 note, whether 900 listed against 129 returned was pagination or unpublished products. It is a snapshot; storefronts change.

## Findings

| Fact | Measured |
|---|---|
| `/collections/televisions/products.json?limit=250&page=1` | 200. 128 products, 3,580,808 bytes, 1.27 s. The page is shorter than 250, so the walk stops and no page 2 is requested |
| `/collections.json?limit=250` | 200. 151 collections, each with a `products_count` |
| `televisions`, count against the endpoint | `products_count` 900; the endpoint returns 128. The count includes products not published to the online store |
| Largest collections | Whitegoods 1204, ovens 940, sinks and taps 915. The store is mostly whitegoods |

Collections of interest, with the store's `products_count`:

| Collection | Count | Note |
|---|---|---|
| `tvs-audio` | 918 | Overlaps `televisions`. Not seeded |
| `televisions` | 900 | Seeded since 2026-10-06 (ADR-0017 item 2). 128 returned |
| `hifi-soundbars` | 92 | Seeded 2026-10-08, category `soundbar` |
| `vacuums` | 172 | Seeded 2026-10-08, dropped 2026-10-12 by Rafi (outside the wedge). Not seeded |
| `coffee-machines` | 104 | Not seeded |
| `air-conditioners` | 160 | Not seeded |
| `dyson` | 35 | A brand collection. Not seeded |

## Conclusions

- A second collection is one request. `hifi-soundbars` is seeded (ADR-0019 item 6). `vacuums` was seeded on 2026-10-08 and dropped on 2026-10-12.
- `tvs-audio` overlaps `televisions` and is not seeded; a product in both would be one row either way, since the upsert key is the handle, but the pull would cost a request for little.
- The counts overstate what a pull returns. 900 listed against 128 returned is not pagination: the page came back shorter than the limit, so there is no second page. The count includes products not published to the online store. The walk of 2026-10-06 was right, and that note's open question is closed. The 129 of 2026-10-06 against the 128 of 2026-10-08 is one product unpublished between the two probes.

## Open questions

- JB Hi-Fi's terms of use for the listing endpoints. Unchanged from the 2026-10-06 note; a pull waits on the answer.
- Whether `tvs-audio` holds products that `televisions` and `hifi-soundbars` miss.
