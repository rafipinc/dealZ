# Where a year of Australian prices can come from: archive captures against models with web search

**Date:** 2026-10-13. **Method:** one product, the tracked Samsung 65-inch OLED S85H (2026), QA65S85HAEXXY, window 2025-10-13 to 2026-10-13. The Wayback captures the lab already reads are the ground truth. Five model routes were asked the same question with the same rules: only points read with a date on a page, the full source URL, the exact quoted fragment. Each returned point was then checked against the cited page or the archive.

Rafi's question was whether the history chart, drawn today from archive captures for the one tracked product ([ADR-0012](../adr/0012-sources-layer-live-fetch-spike.md) item 8), can be drawn for any product from a button. The archive is sparse. Could a model with web search fill the year?

## Ground truth: 16 archive captures

Read by the lab's archive source on 2026-10-13. Prices in AUD, dates in 2026.

| Retailer | Captures | Points |
|---|---|---|
| JB Hi-Fi | 4 | 3295 on 05-14, 2495 on 06-08, 2795 on 08-07, 2795 on 09-27 |
| The Good Guys | 4 | 3295 on 04-21, 3295 on 05-14, 2788 on 08-07, 2795 on 09-27 |
| Samsung AU | 1 | 2799 on 09-05 |
| Harvey Norman | 3 | 3295 on 05-14, 2788 on 08-07, 2788 on 09-27 |
| Bing Lee | 3 | 3295 on 05-14, 2788 on 08-07, 2795 on 09-27 |
| Powerland | 0 | none |
| Toptek | 0 | none |

## Scorecard

Verified means the price and date were found on the cited page, or agree with an archive capture. Not checkable means the page could not be re-read, or had changed by the time it was. Wrong means the cited page contradicts the point or does not exist.

| Route | Points | Verified | Not checkable | Wrong | Time | Cost |
|---|---|---|---|---|---|---|
| Wayback Machine, the lab's archive source | 16 | 16 | 0 | 0 | Seconds | Free |
| OpenAI gpt-6-luna, Responses API, web search, domain allow-list, 6 tool calls at most | 4 | 4 on price; 0 on the date as given | 0 | 0 | 28 s | About 5 cents |
| The same GPT model in the ChatGPT app, run by Rafi, no domain filter | 18 | 2 | 16 | 0 | Not timed | App subscription |
| Claude Haiku 5.6 in the Claude app | 1 | 1, an RRP | 0 | 0 | Not timed | App subscription |
| Gemini 3.8 Flash, Google Search grounding | 3, then 1 on the same prompt at temperature 0 | 1 | 2 | 0 | 59 to 83 s | About 4.5 cents |
| Gemini 3.5 Flash-Lite, Google Search grounding | 0 under the strict prompt, 2 under a loose one | 0 | 1 | 1 | Short | Negligible |

### OpenAI through the Responses API

The allow-list held the known retailers plus catalogue.jbhifi.com.au, ozbargain.com.au and press-start.com.au. The run made 5 tool calls, 3 searches and 2 page opens, and used 44,210 input and 2,116 output tokens.

All 4 points came from JB Hi-Fi catalogue pages: 2026/05/28-05-syt, 2026/07/02-07-acp, 2026/07/30-07-acp and 2026/09/03-09-ldd. The prices agree with the archive. The dates do not. The model gave 05-14, 06-22, 07-16 and 08-20, each about two weeks before the catalogue date in the URL. A catalogue page carries a dozen "Started dd/mm/yyyy" labels, one per promotion, and the model picked one near the product. The page knew the date. The model did not.

### The same model in the ChatGPT app

Rafi ran the same question in the app with no domain filter. It made 17 searches and opened 11 pages, and returned 18 points.

| Standing | Points | Detail |
|---|---|---|
| Verified | 2 | JB Hi-Fi catalogue 2026/06/04-04-tax: $2,495, ticket $3,295, "Started 28/05/2026", agreeing with the archive's 2495 on 06-08. Bing Lee $2,795, updated 25-09-2026, on StaticICE |
| Page blocked to scripts | 1 | Catalogue 2026/07/30-07-acp returns 403 to curl |
| Rolled forward | 15 | StaticICE listing stamps that had moved on by the time the page was re-read |
| Contradicted by the archive | 0 | |

Eighteen points from one question is the breadth the archive lacks. Sixteen of them cannot be checked after the fact, which is the problem.

### Claude Haiku in the Claude app

One point: the Press Start article of 2026-03-16 stating the 65-inch RRP of $3,299. Real, dated, and not a shelf price. Not run through the API.

### Gemini with Google Search grounding

Gemini 3.8 Flash gave 3 points on the first run and 1 on the same prompt at temperature 0. One verified: an OzBargain post of 2026-07-12, Samsung partner portal, $1,979.40. The other two cited a bare domain and nothing on it.

Gemini 3.5 Flash-Lite never searched. The prompt token count stayed under 200 on every run, which means no search results were ever added to its context. Under the strict prompt it returned an empty list three times. Under a loose prompt it returned two points that cannot be verified, one of them citing a page that is a 404. Asked separately for 9 retailer page URLs for this product, it gave 5 right and 4 constructed, and the constructed ones differed between runs.

## Sources found and their standing

| Source | What it is | Standing |
|---|---|---|
| StaticICE, staticice.com.au | Australian tech price comparison engine of about 199 stores, refreshed daily by its own crawler. No API, no history | Out. Its [disclaimer](https://staticice.com.au/disclaimer.html) says the service is for personal use only and results may not be taken and displayed elsewhere |
| JB Hi-Fi catalogue archive, catalogue.jbhifi.com.au | Past catalogues, dated by URL, carrying model codes, prices and "Started" dates. robots.txt allows all | Usable pending terms, to be read under issue 13 |
| OzBargain, ozbargain.com.au | Community deal posts, each dated | The deals RSS feed answers. Search pages return 403 to scripts |
| Press Start, press-start.com.au | Gaming and tech news | RRP announcements only |
| PricesAPI, pricesapi.io | A paid price history API. USD 49 a month for 3,000 searches. History in beta. Redistribution terms not stated | Rejected by Rafi on cost |

## Cost per chart drawn

After free tiers. Provider prices as read on 2026-10-13.

| Route | Per chart | Basis |
|---|---|---|
| Wayback Machine | $0 | No charge |
| gpt-6-luna, domain-filtered | About 5 cents | Tokens USD 0.10 in and USD 0.50 out per million; web search USD 10 per 1,000 calls |
| gpt-6-luna, unfiltered | About 18 cents | Same rates, 17 searches |
| Gemini 3.8 Flash, grounded | About 4.5 cents | Grounding USD 14 per 1,000 queries after 5,000 a month free |
| Claude Haiku 5.5, web search | About 1.5 to 3.5 cents | Web search USD 10 per 1,000 |
| PricesAPI | USD 49 a month | Subscription |

## What it decides

The model is good at finding pages and poor at reading dates off them. Every route that stated a date of its own got it wrong or could not show where it came from. Every page the OpenAI run cited was real, and each one stated the price and the date itself.

So: the model finds pages, the page states the price and the date. That is [ADR-0020](../adr/0020-model-assisted-price-history.md).

## Open questions

- Whether JB Hi-Fi catalogue pages are stable at their URLs, so a point verified today can be re-verified later.
- The JB Hi-Fi catalogue terms of use. Issue 13.
- How many catalogue points a non-TV product gets. TVs are catalogue staples; a cable may never appear.

## Pages read

Only these were read for the figures above.

- [ai.google.dev/gemini-api/docs/pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [developers.openai.com/api/docs/pricing](https://developers.openai.com/api/docs/pricing)
- [developers.openai.com/api/docs/guides/tools-web-search](https://developers.openai.com/api/docs/guides/tools-web-search)
- [platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)
- [staticice.com.au/disclaimer.html](https://staticice.com.au/disclaimer.html)
- [pricesapi.io](https://pricesapi.io)
