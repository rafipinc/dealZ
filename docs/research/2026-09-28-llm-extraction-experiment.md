# Can a small language model read a price from page text? Five pages, two Gemini models

**Date:** 2026-09-28, evening. **Method:** the visible text of five saved retailer pages, with all script and JSON-LD removed, trimmed to the head of the page plus windows around every dollar sign, sent to Gemini with a strict JSON response schema and a system prompt that asks for evidence, not judgement. The JSON-LD on the same page is the truth the answer is scored against. Script: kept in the session scratchpad; the production version is `src/sources/llm-extract.ts`. **Reference product:** Samsung 65-inch OLED S85H (2026), QA65S85HAEXXY.

Rafi's question was how strong a model this needs. The answer on this sample: the smallest one.

## Results

| Page | Truth (JSON-LD) | gemini-3.8-flash | gemini-3.5-flash-lite | Notes |
|---|---|---|---|---|
| JB Hi-Fi | $2,795.00 | $2,795, was $3,295, QA65S85HAEXXY | same | Both right. Evidence "Sale price: $2795" |
| The Good Guys | $2,795.00 | $2,795, was $3,295, QA65S85HAEXXY, in stock | same | Both right. Evidence "EPIC DEAL $ 2795" |
| Powerland | $2,388.00 | $2,388, QA65S85HAEXXY, in stock | same | Both right. An independent Shopify store |
| Samsung AU | $2,799 | $2,579.96, doubts raised | same, doubts raised | Both wrong, both said so. The visible text carries a leftover template block in pounds ("£3,299.00 £2,399.00") and a stray dollar figure; the real price sits in a script |
| Toptek | $4,158.00, out of stock | no price, doubts raised | same | Both correctly reported no price: the trimmer had kept only menu text because the page writes the price with an entity, not a dollar sign. A trimmer defect, fixed in `src/lib/page-text.ts` |

Three of five right on both models, and the two misses were each flagged by the model itself. No silent wrong answer. That is the property the confidence rules depend on.

## Cost and speed

| Model | Input tokens per page | Output plus thinking tokens | Time per page | Cost per page at list price |
|---|---|---|---|---|
| gemini-3.8-flash | 680 to 1,440 | 300 to 1,200 (thinking dominates on the hard page) | 2.8 to 6.9 s | about 0.3 to 0.6 cents |
| gemini-3.5-flash-lite | same input | 150 to 210, no thinking | 1.4 to 2.2 s | about 0.1 cents |

Prices used: 3.8 Flash $0.75 input and $3.75 output per million; 3.5 Flash-Lite $0.30 and $2.50. Both introductory and subject to change. At phase 4 volume, a few hundred pages a day with most read from structured data without a model, either model costs single-digit dollars a month.

## What this decides

- **Model tier.** Flash-Lite matched Flash on every page. It is the proposed extraction tier, with Flash as the escalation when the extractor reports doubts (ADR-0013).
- **Evidence beats confidence.** Asking for the exact text fragment the price came from is what makes the answer checkable. The production source verifies that the fragment exists in the text it sent; a fragment that is not there means the model invented it, and the quote drops to 0.3.
- **The trimmer matters more than the model.** Both misses were input problems: template noise on Samsung, a dropped price on Toptek. Trimming is deterministic code with tests; the model is not where to spend effort.
- **Region hint.** Telling the model the retailer's country stopped it reporting the pound price on the Samsung page, though it then picked a wrong dollar figure and said so. Mixed-currency pages stay a review case.

## Open questions

- A larger labelled set. Five pages is enough to choose a tier, not to quote an accuracy figure. Rafi's confirmations in the lab become the labels.
- Listing pages and bundles have not been tested; the schema has fields for both and the rules cap confidence when they fire.
- Whether the escalation to Flash on doubt changes any outcome. On this sample it would not have.
