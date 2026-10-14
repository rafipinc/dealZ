# ADR-0020: A model with web search finds dated price pages; the page, not the model, states the price and the date

**Status:** Proposed
**Date:** 2026-10-13
**Decider:** Rafi (the use of OpenAI proposed by Rafi; the verification rules, domain policy and caps proposed by Claude)

## Context

The lab draws a history chart from Wayback captures for the one tracked product ([ADR-0012](0012-sources-layer-live-fetch-spike.md) item 8). Sixteen captures across five retailers is the whole year, and most products will have fewer. Rafi wants the chart for any product found in the lab, from a button. The [research note](../research/2026-10-13-price-history-sources.md) of 2026-10-13 compared the archive against five model routes with web search. Rafi chose OpenAI gpt-6-luna through the Responses API for its results: every page it cited was real and carried the price and the date, while every date the model stated itself was wrong by about two weeks.

[ADR-0013](0013-llm-extraction-boundaries.md) says a model-read price never reaches a chart, and ADR-0012 and ADR-0013 both rejected a model with web search as a price source because it returned snippets with no provenance. This record supersedes ADR-0013 item 4 for one case: a point the model found that has been verified on its page. The rest of ADR-0013 stands. The model still states nothing; it finds the page, and the page is read.

## Decision

1. **A new source, `history_search`.** It asks the model, through the Responses API web search tool, for dated price points for one product in a window, with a domain allow-list and a cap on tool calls. `src/sources/openai.ts` is the only file that knows the provider's API, as `src/sources/gemini.ts` is for Gemini.
2. **Every point the model returns is a claim.** The source fetches the cited page itself, finds the quoted fragment in the page text, and dates the point from the page or its URL. The model's own date is never used.
3. **Confidence by rules**, in one pure function with a test per rule.

   | Outcome of verification | Confidence | Shown as |
   |---|---|---|
   | Fragment found; page or URL dated | 0.8 | Charted, solid point |
   | Price and the product's identifier found near each other, fragment not found; dated | 0.6 | Candidate, listed with its reason, never charted |
   | Fragment found, strong or weak; no date on the page or in the URL | 0.5 | Candidate, undated, never charted |
   | Page unreachable | 0.4 | Listed as unverified |
   | Page fetched, fragment absent | 0.3 | Listed as rejected, with the reason |

   Only a point at or above `REVIEW_THRESHOLD` (0.7, `src/sources/types.ts`) is charted solid. A verified model-found point ranks below an archive capture (0.9) and live structured data (1).
4. **A domain allow-list, held in code** with a terms note per domain. StaticICE is excluded because its terms forbid redisplay. A source whose terms forbid redisplay is never added, whichever machine fetches it.
5. **Spend is capped three ways.** A hard monthly limit in the provider console, set by Rafi (USD 5 on 2026-10-13). An `OPENAI_DAILY_CAP` of requests per Sydney day in the ledger, like `SERPAPI_DAILY_CAP`. At most 6 tool calls a request. The provider bills per search query, not per tool call: a response carries both `search` and `open_page` tool calls, and its `tool_usage.web_search.num_requests` counts the searches only (3 of 5 in the recorded fixture). Each response is one ledger row with its tokens. Each search is a `web_search_call` row priced at USD 10 per 1,000, and each page open a `web_search_open_page` row priced at zero, so the ledger shows every call and prices only what is billed. When the ledger cannot be read, the search is skipped rather than spent blind (`budget-unknown`), the same rule as the SerpApi cap.
6. **Every charted point links to the page it was verified on**, as the provider's terms require for search-derived facts shown to users.
7. **Scope now:** the tracked product in the lab, scored against the archive. Any index product follows issue 10. Persistence as `price_observation` rows with `source = 'api'` follows issue 12; once results persist, a product is not searched twice within seven days. Scheduled runs wait on issue 13.

## Options rejected

- **The model states the price and the date.** Dates were wrong by about two weeks on every point in the probe.
- **No domain filter.** Brings in sources whose terms forbid redisplay, and sixteen of eighteen points could not be checked.
- **PricesAPI.** USD 49 a month, history in beta, redistribution terms unstated.
- **Gemini with Google Search grounding.** Flash-Lite never searched. Flash gave 1 to 3 points in 60 to 80 seconds.
- **Claude web search.** One RRP point in the manual test. Not run through the API.
- **The archive alone.** Sparse. It misses catalogues and deal posts, which is where the off-RRP prices are.

## Consequences

- Cost is about 5 cents a chart, bounded by the three caps.
- The history chart carries two kinds of point: archive captures and verified model-found pages. Each is drawn differently and each links to its page. Live prices stay on the price panel.
- The research note's 18 manual points and the 4 probe points are the first labelled set for the verifier.
- ADR-0013's status line notes the amendment. Its body is unchanged.
- Revisit when a non-TV product is charted, when the provider changes its prices, or when issue 12 persists points.
