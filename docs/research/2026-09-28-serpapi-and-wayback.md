# Two more ways to a price: Google Shopping through SerpApi, and the Wayback Machine for history

**Date:** 2026-09-28, afternoon, after the [live fetch note](2026-09-28-s85h-live-fetch.md). **Method:** documentation reading for SerpApi; HTTP probes of the Wayback Machine's two lookup endpoints for the five tracked pages. **Reference product:** Samsung 65-inch OLED S85H (2026), QA65S85HAEXXY.

Rafi's question was how to get any retailer's price, including the two behind bot protection, and whether history can be had from anywhere. These are the two routes chosen for the lab.

## Google Shopping through SerpApi

SerpApi is a paid third party that runs a Google search and returns the results as JSON. Its `google_shopping` engine returns every seller Google lists for a query, with price, seller name and a link. A second engine, `google_immersive_product`, takes a token from a result and returns up to thirteen stores for that one product with base price, shipping and total.

| Fact | Value | Source |
|---|---|---|
| Endpoint | `GET https://serpapi.com/search.json?engine=google_shopping&q=...&gl=au&hl=en&google_domain=google.com.au&api_key=...` | SerpApi docs |
| Result item | `title`, `source` (seller name), `price`, `extracted_price`, `product_link`, sometimes `link`, `delivery`, `product_id`, `immersive_product_page_token` | SerpApi docs |
| Price freshness | Whatever Google's shopping index holds, typically hours old | Not measured |
| Cost | Free tier of about 100 searches a month; roughly $75 a month for 5,000 | SerpApi pricing page, September 2026 |
| Key | `SERPAPI_API_KEY` in `.env.local`, never committed | This project |

Not verified against a live response: no key existed on 2026-09-28. The parser is built from the documented shape with a synthetic fixture that says so in its first field. The first live call replaces it with a recorded one.

What it gives DealZ: sellers we do not know about, including independents, in one call; and the two bot-protected chains, because Google reads their feeds, not their pages. What it does not give: a GTIN. Matching a Google result to a tracked variant relies on the model code in the title and the seller name.

## The Wayback Machine for history

The Internet Archive keeps dated copies of web pages. An archived retailer page still carries its JSON-LD `Product` block, so the same parser that reads a live page reads a copy from May. Two lookup endpoints:

| Endpoint | Host | What it returns | Status on 2026-09-28 |
|---|---|---|---|
| CDX index, `/cdx/search/cdx?url=...&output=json` | web.archive.org | Every capture of a URL with timestamp and status, filterable and collapsible by day or month | Unreachable: TCP connections to 207.241.237.3 timed out on ports 80 and 443 from this machine, from the app's browser pane and from a remote fetcher |
| Availability, `/wayback/available?url=...&timestamp=...` | archive.org | The single capture closest to a timestamp | Working |
| Raw capture, `/web/<timestamp>id_/<url>` | web.archive.org | The original bytes of that capture, no toolbar | Unreachable, same host as the index |

Because the index host was down while the availability host answered, the archive source discovers captures through the index first and falls back to walking the availability endpoint month by month. Neither route could be exercised end to end today; the parser is tested on recorded page HTML and documented response shapes.

## Captures found for the tracked pages

First probe, one availability call per page with no timestamp, then per month for two pages. Second probe, the lab's archive source walking the availability endpoint month by month for every page after the index host failed.

| Page | First probe | Lab run, captures listed April to September | Downloads |
|---|---|---|---|
| JB Hi-Fi | 2026-05-14, 2026-06-08, 2026-08-07, 2026-09-27 | 3 (monthly closest, deduplicated) | all failed, host unreachable |
| The Good Guys | none | 4 | all failed |
| Samsung AU | 2026-04-22, 2026-09-05 | 3 | all failed |
| Harvey Norman | 2026-09-27 | 2 | all failed |
| Bing Lee | none | 2 | all failed |

The first probe under-counted: a call with no timestamp returns only the capture closest to now, and for two pages that returned nothing. Walking months finds captures for every page. So the backfill for this TV is roughly fourteen dated points across five retailers, once the capture host answers. Whether the Harvey Norman and Bing Lee captures hold the page or the bot challenge is unknown until then. Each point becomes a quote with `provenance.kind = "archive"` and the capture URL in `provenance.via`, so a chart can draw archived points differently from live ones and a later `price_observation` can carry `source = 'api'` with lowered confidence.

A capture that is listed but cannot be downloaded or parsed is reported by the source as skipped, with its kind. The quotes service turns "captures found, none fetchable" into a failed page, so an outage never reads as an empty history.

## Open questions

- Confirm the SerpApi response shape and record a real fixture once a key exists.
- Confirm the Harvey Norman capture is the real page.
- Whether the CDX host outage was local to this network or general. Retest before relying on the index route.
- Rate: the archive source fetches at most three captures at a time and twelve per page. Fine for a click in the lab; a scheduled backfill needs a politeness delay and a cache.

## Update, 2026-10-01

Added without changing the record above, which stands as written on 2026-09-28.

The Wayback Machine route was run live for the first time on 2026-10-01. web.archive.org answered, the index and the captures both.

| Fact | Value |
|---|---|
| Captures found | 16, across 5 retailers |
| Captures read | 16. None skipped |
| Retailers with no capture | Powerland, Toptek |
| Harvey Norman and Bing Lee captures | The real product page with a price, not the bot challenge |
| Lowest archived price | JB Hi-Fi, $2,495 on 2026-06-08 |

So the archive route is verified live, not against fixtures only. The "roughly fourteen" estimate above was two short.

Two statements above went stale on the evening of 2026-09-28:

- The SerpApi key does not live in `.env.local`. It is in the macOS Keychain and is injected by `scripts/keys.sh` ([SETUP.md](../SETUP.md), "API keys").
- The SerpApi parser is no longer unverified. Recorded, redacted fixtures from live calls replaced the synthetic one, and the source became a two-hop search: `google_shopping` for the product entity, then `google_immersive_product` for its stores.

The open questions, answered:

| Question | Answer |
|---|---|
| Confirm the SerpApi response shape and record a real fixture | Done on 2026-09-28, evening |
| Confirm the Harvey Norman capture is the real page | Yes, and the Bing Lee captures too. Confirmed 2026-10-01 |
| Whether the CDX host outage was local or general | Not determined. The host answered on 2026-10-01, so the index route is usable. The fallback to the availability endpoint stays |
| Rate for a scheduled backfill | Still open. Needs a politeness delay and a cache before phase 4 |

The Wayback Machine stays the history source. It is not a layer of the live-price ladder that Rafi decided on 2026-10-01 ([ADR-0012](../adr/0012-sources-layer-live-fetch-spike.md) item 8).
