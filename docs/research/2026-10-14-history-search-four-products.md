# The model-assisted history across four products: a TV it was built on, a TV it was not, a phone and a console

**Date:** 2026-10-14. **Status:** Claude's test run, uncommitted, for Rafi to read. **Method:** the code on branch `p1/history-search` as it stands, run from a scratch script against the live OpenAI Responses API with the project's allow-list of twelve domains ([ADR-0020](../adr/0020-model-assisted-price-history.md)). The tracked Samsung S85H went through `fetchHistory`, so archive and model ran together. The other three products are not tracked variants, so they went to the `history_search` source directly with a title and, for the S90H, a model code. Every call was metered to the local ledger. Model `gpt-6-luna`, up to 6 tool calls per request, up to 12 claims kept.

## Scorecard

Verified means the quoted fragment is on the cited page verbatim and the page carries a date. Candidate means the fragment is there but the page has no date. Rejected means the page was read and the fragment is not on it.

| Product | Window | Searches | Page opens | Claims | Verified | Candidate | Rejected | Time | Cost (USD) |
|---|---|---|---|---|---|---|---|---|---|
| Samsung 65" OLED S85H, tracked, QA65S85HAEXXY | 2026-04-01 to today | 3 | 2 | 0 | 0 | 0 | 0 | 47 s with the archive | 0.035 |
| Samsung 65" OLED S90H, QA65S90HAEXXY | 2026-04-01 to today | 3 | 1 | 0 | 0 | 0 | 0 | 15 s | 0.033 |
| Apple iPhone 17 Pro Max 256GB | 2025-09-19 to today | 3 | 4 | 12 | 9 | 2 | 1 | 49 s | 0.038 |
| Microsoft Xbox Series X 1TB | 2025-10-14 to today | 1 | 1 | 1 | 0 | 0 | 1 | 8 s | 0.013 |

Whole run: 4 requests, 10 searches, 8 page opens, USD 0.119. Searches are USD 0.01 each and are 84 percent of the cost; tokens are the rest.

## The S85H: the archive did the work, the model found nothing

The archive returned the same 16 points across five retailers as on 2026-10-13, lowest JB Hi-Fi at 2495.00 on 2026-06-08. Powerland and Toptek have never been captured. The Samsung AU capture of 2026-04-09 has no price to parse.

The model made three searches and opened two pages, then returned an empty array. On 2026-10-13 the same question returned one claim (a Samsung press release, unverified) and the probe before it returned four catalogue claims. Three runs, three answers: zero, one, four. The parked note on recall variance holds.

## The S90H: an untracked TV, nothing found

Same window, same allow-list, a model code I supplied by pattern from the S85H's (QA65S90HAEXXY, not checked against a retailer page). Three searches, one page open, empty array. The TV retailers on the allow-list carry no dated price pages the model could cite, and the OzBargain and JB Hi-Fi catalogue pages that gave the probe its four points did not surface this time.

## The iPhone 17 Pro Max: nine verified points across ten months

Every claim came from ozbargain.com.au. Nine were deal posts, each dated by the post, each with the fragment found verbatim. The model's own date matched the page's date on all nine.

| Date on page | Seller as posted | Price AUD | Page |
|---|---|---|---|
| 2025-11-27 | digiDirect | 1999.00 | ozbargain.com.au/node/936795 |
| 2025-11-27 | DIGI Online | 2099.00 | ozbargain.com.au/node/936571 |
| 2025-12-24 | digiDirect | 2108.22 | ozbargain.com.au/node/941699 |
| 2026-01-23 | digiDirect | 1977.30 | ozbargain.com.au/node/945285 |
| 2026-01-31 | digiDirect | 1977.30 | ozbargain.com.au/node/946191 |
| 2026-05-13 | SkyTree Electronics | 2000.00 | ozbargain.com.au/node/959100 |
| 2026-05-13 | digiDirect | 2087.15 | ozbargain.com.au/node/959067 |
| 2026-06-10 | Amazon AU | 2049.00 | ozbargain.com.au/node/962773 |
| 2026-07-07 | SkyTree Electronics | 1899.00 | ozbargain.com.au/node/966784 |

The three that did not verify all cite the OzBargain product listing page rather than a post. Two are candidates: the fragment is on the listing but the listing has no date of its own (Emporium Electronics 2195.00, digiDirect 2087.15). One is rejected: the Umart 2129.00 fragment is not on the listing at all, most likely because the listing has paged past it. The verifier handled all three as designed: the point is not charted, the reason is stated.

Exactly 12 claims came back, which is the cap. The model may have had more.

Spot check by hand: the 2026-07-07 page carries the title "iPhone 17 Pro Max 256GB $1,899, 512GB $2,200 Delivered @ SkyTree Electronics", as quoted.

## The Xbox Series X: one search, one wrong page

One search, one page open, one claim: JB Hi-Fi at 729.00 on 2025-11-25, citing the OzBargain product listing. The fragment is not on the listing, so the claim was rejected. The model stopped after one search of the six it was allowed. A console a year into its price history ought to have deal posts; the model did not look for them.

## What this says

1. **The verifier works on every outcome it was built for.** Nine verified with page dates, two dated-nowhere candidates, two absent-fragment rejections. No model date was ever used; no point charts without a page link. ADR-0020 items 3 and 6 hold under a product the design never saw.
2. **Recall depends on the product's community footprint, not on DealZ.** The iPhone has a deal post every few weeks on OzBargain, so it has a history. The two TVs and the console have few or none inside the allow-list, so the model had little to cite and once stopped early.
3. **The OzBargain product listing page is a trap the verifier catches.** It holds fragments without dates, and loses them as it pages. Three of the fifteen claims in this run cited it. A rule that steers the model to `/node/` posts, or a note in the prompt, is a cheap recall gain. Claude's proposal; not decided.
4. **The 12-claim cap bit on the one product with a real history.** Raising it costs one page fetch per extra claim and no model spend. Claude's proposal; not decided.
5. **The model-code guess for the S90H was unchecked.** A wrong code would not explain a zero, since the title alone names the TV, but the test is not clean on that point.
6. **A test artefact in the ledger.** The script injected a fixed clock, so all 85 rows from this run share one `called_at` of 03:54:31 UTC. The spend is real and counts against today's cap of 10 requests (4 used). The `/lab/status` last-20-calls list orders them arbitrarily.

## Not tested

Nothing was persisted; every point above was verified, printed and forgotten, as the branch stands. The archive route was not tried for the three untracked products because they have no retailer pages on file. Gemini and SerpApi were not called.
