# Public allowlist

What the public build log may show. Default deny: an ADR, session, journey or component without a row here, or in [BUILD_MAP.md](BUILD_MAP.md), is not published and fails the build. Set by [ADR-0015](adr/0015-public-build-log.md). Every summary is Claude's draft until Rafi approves it in a session recap.

The rule from Rafi, 2026-10-01: show the architecture and the development process. Do not show how prices are fetched from retailers. Never show the lab page.

## Decisions

`full` publishes the record as written. `summary` publishes only the title and text in this table, with the record's status, date, decider and proposer; a `summary` row must have both. `hidden` publishes nothing.

| ADR | Treatment | Public title | Public summary |
|---|---|---|---|
| 0001 | full | | |
| 0002 | full | | |
| 0003 | summary | Launch data is entered by hand; automated sources wait until phase 4 | Launch data is entered by hand through the admin flow. Automated data sources wait until phase 4, once the data model has been exercised by real entries. Rejected: any automated source in v1, because each adds legal, operational and data-quality risk before the product exists to justify it. |
| 0004 | full | | |
| 0005 | full | | |
| 0006 | summary | A deal is a separate entity from a price observation | A deal is an editorial call; a price observation is a recorded fact. The deal has its own table, with its own title, commentary, status and lifecycle, and it references the observation that triggered it. It reaches the listing and the product only through that observation, so the two can never disagree. Rejected: a commentary column on the fact table, which would let editorial edits mutate facts; a second link from the deal to the listing, which could drift from the first. |
| 0007 | summary | Price history is append-only, enforced by a database trigger | The price history table accepts inserts only. A database trigger raises on update and delete, and a correction is a new row that supersedes the bad one. Rejected: convention alone, which fails the first time a row looks wrong; revoking privileges from the application role, which is easy to lose when roles change. |
| 0008 | full | | |
| 0009 | full | | |
| 0010 | summary | Every listing records how it was matched; weak matches are staged, never merged | Every listing records how it was matched to a product, with what confidence and when. Exact identifier matches merge automatically. Weaker matches never do: they are staged as candidates and become listings only once confirmed. Rejected: a nullable link to the product, which puts a null guard in every query; no audit columns, which makes the first wrong merge undetectable. |
| 0011 | full | | |
| 0012 | summary | A separate layer for external price data, behind one quote type | A separate code layer holds everything that talks to the outside world for price data. It may import only the pure helpers, never the database, and the network client is injected so tests replay recorded fixtures. Every source returns the same quote type, carrying where the price came from, when it was true and how far it can be trusted. Rejected: putting network code inside services, which would make their unit tests need stubs for it; persisting quotes before the services that own the invariants exist. |
| 0013 | summary | A language model returns evidence, rules assign the confidence, and it never sets a price on its own | A language model is used only under fixed rules. It returns evidence, the exact text a value was taken from, and is never asked how confident it is. A pure, tested rule function assigns the confidence, bounded below that of a deterministic source. A low-confidence result is a candidate for human review and never a fact on its own. One module knows the provider. Rejected: self-reported confidence, which is poorly calibrated and cannot be tested; a provider-neutral framework before a second provider exists. |
| 0014 | summary | Every outbound call is recorded in an append-only ledger, shown on a private status view | Every request the backend makes to an external service is recorded as one row: what was called, when, how long it took, whether it worked and an estimated cost. The table is append-only, enforced by a database trigger. The code that makes a request never touches the database; it reports each call through an injected callback, and the service writes the rows afterwards, best effort, so a ledger that cannot be written never changes a result. Costs are estimates from a dated price table, stored as integers. A status view for the developer alone shows service health and usage, and is served only by a development server. Rejected: a log file, which has no constraints and no queries; a login-protected admin page before authentication exists; a budget cap, which needs a policy for what a blocked request reports. |
| 0015 | summary | A public build log generated from the repository, as a separate project with a default-deny allowlist | The build log is a separate static project that holds no content of its own. A generator reads the decision records, two registries and the commit history, and writes the one file the pages render. One registry lists every component with its stage and is checked against the code. The other is an allowlist: nothing is published without a row, and a blocklist is the second guard. Each decision shows its decider and its proposer, parsed from the record. Rejected: a route inside the product app, which would share a deployment with internal tools; publishing documents verbatim; deriving stages from the code alone, which cannot tell a spike from finished work; a portfolio page written by hand at the end, which asserts involvement instead of showing the record. |
| 0016 | summary | Products are discovered from external sources as candidates, and the catalogue grows only by confirmation | A discovery service searches the catalogue first and external sources second, kept apart and always in that order, so a product already held is never offered as new. The external-data layer gains a second output type for this: a product candidate, which carries a title, a brand, the identifiers a source exposes and where each came from. A candidate is not a fact. Nothing is created from a search alone, and a candidate becomes a product, a variant and its identifiers only when the developer confirms the fields. The first external source is free; a paid aggregator is the next rung, in a later change. Rejected: the paid aggregator first, which spends quota where a free source already answers; automatic creation from a search, because a wrong product family poisons price history; a general framework for every product category now, since matching quality follows identifiers and the single starting category stands. |
| 0017 | summary | A local index of candidate products, seeded cheaply and learned from use, searched as you type | Product search runs on the developer's own database, not on external sources. A local index holds one row per candidate product seen: it is seeded cheaply from one source, grows from every search and every identifier read, and is searched with a trigram index in Postgres as the developer types. The index is never a fact table; it is a snapshot that can be wiped and rebuilt, and nothing in the catalogue references it. Adding a product stays a confirmed action. A paid aggregator is consulted only on an explicit search that the local index cannot answer, under a daily cap. Rejected: calling external sources on every keystroke, which is too slow and too costly; a full pull of a large source whose terms are unread; a separate search engine, a second system for a few thousand rows that the database already handles. |

## Sessions

One row per row of [AI_USAGE_LOG.md](AI_USAGE_LOG.md), in the same order, matched by number and date. The full log row stays in the repository; the site shows only these two columns.

| # | Date | Treatment | Rafi | Claude |
|---|---|---|---|---|
| S-01 | 2026-09-15 | summary | Brought the product idea and the mission. Made the first five decisions: web first, one category, hand-entered launch data, the primary product identifier, a strict condition model. | Field research on how products are identified, and a draft four-layer data model. |
| S-02 | 2026-09-17 | summary | Reviewed the draft model. Decided that a deal is separate from a price, that price history is append-only, and the data access approach. | The database schema, the trigger that enforces append-only history, three decision records and a setup guide. |
| S-03 | 2026-09-17 | summary | Asked for a full architecture review against the goals, then accepted its recommendations. | A review that found three schema defects and contradictions between documents. Reorganised the repository, wrote the architecture document, fixed the schema and verified it against a real database engine. |
| S-04 | 2026-09-18 | summary | Asked, before any application code, for conventions on three things: scoped subagents, tests with a guarantee of end-to-end coverage, and documentation that serves both future sessions and a reader judging the work. | The CLAUDE.md hierarchy, six subagents scoped by language and layer, the testing policy, a journey registry with a CI check, the documentation map and the CI workflow. |
| S-05 | 2026-09-18 | summary | Asked for a walk through every key decision, then chose to start building rather than plan further. Accepted two gaps found in the service plan. | An architecture diagram, a recommendation on each open decision, and a boundary for where a language model may and may not be used. |
| S-06 | 2026-09-22 | summary | Accepted the development conventions. Asked for the first commit and the application scaffold. | The scaffold with strict TypeScript, linting, unit and database test runners, and the setup guide corrected for what it had not anticipated. All CI commands green. |
| S-07 | 2026-09-22 | summary | Asked for the first pull request to be merged and the local database stack to be set up. | The local stack, the first two migrations generated and checked line by line against the data model, and nine invariant checks run by hand, each failing with its named error. |
| S-08 | 2026-09-24 | summary | Asked whether the migrations branch could close. | A status check that found three documentation fixes outstanding and no review yet run. The reviewer agent confirmed the migrations match the schema. |
| S-09 | 2026-09-28 | summary | Asked to bring the price data model forward so that real data shapes it. | A new code layer for external price data with injected network access and recorded fixtures, pure parsing helpers, a service that reports each outcome separately, and a decision record proposing the layer. 207 tests. |
| S-10 | 2026-09-28 | summary | Challenged the first results and asked for options. Chose from the options table and rejected the rest. | An options table with trade-offs, and provenance and condition recorded on every quote. 314 tests. |
| S-11 | 2026-09-28 | summary | Questioned whether the chosen approach was the best one. Decided that a language model must return evidence rather than rate its own confidence. Chose how secrets are kept locally. | An experiment comparing two model sizes, a decision record on the limits of model use, a rule function that assigns confidence from evidence, and local secret handling that keeps keys out of files. 435 tests. |
| S-12 | 2026-10-01 | summary | Decided how the service orders its data sources by cost, and rejected two alternatives the same day. | The ordering in the service, a report field that explains each outcome, and eleven new tests. 446 tests. |
| S-13 | 2026-10-01 | summary | Asked for a public view of the development workflow for prospective employers. Decided it is a separate project, that internal tools are never public, and that the public scope is architecture and process only. | The plan, a decision record, a registry of components and their stages, an allowlist, and this site: a static export generated from the repository, with checks that fail the build when the registries and the code disagree. |
| S-14 | 2026-10-01 | summary | Asked for a private dashboard of backend health and spending. Narrowed the first proposal: local only, no login, no budget cap, the ledger in the local database. Delegated ten smaller design decisions, then accepted them. | An append-only ledger of outbound calls with its migrations and invariant tests, call metering injected into the external-data layer, a dated price table, two services and a status view. 891 tests. |
| S-15 | 2026-10-02 | summary | Asked for a review of both pieces of unmerged work and for them to be brought together. Decided which record kept its number, how the two changes landed, and accepted both decision records. | Two independent reviews with no blockers; two defects fixed, each with a failing test first; the continuous integration job for build metrics hardened; the two branches reconciled and the registries filled in for the new components. 893 tests. |
| S-16 | 2026-10-06 | summary | Asked for a product search dashboard and a plan for developing the catalogue. Asked how far the design expands beyond one category. Chose the free retailer route first and the paid aggregator second. Ran it locally and asked for a search bar on the page to look products up. Searched for a games console, got accessories and unrelated products, and asked for the search to be made relevant. Then asked for a lightweight search over most products that runs on the project's own database and answers as you type, fast, relevant and cheap on external data. Chose which sources seed the index and where the search lives. | The plan, a field probe of three storefronts, a decision record, a research note and the registry rows. Then the first discovery pieces, with tests: a pure rule that reads a model code from a product title and names its own misses, routing that tells an identifier from text, an external-data source that returns product candidates rather than prices, a service that asks every answering store in parallel and reports each outcome side by side with products already held marked, and a search bar on the developer tool. Then a relevance rule that ranks results from external sources by how fully the title matches the query, with the weak matches hidden but inspectable. Then a local index of candidate products in the database, searched with a trigram index as the developer types: a table with its migrations and invariant tests, a source that reads one store's product list page by page, a service that seeds the index, learns from every search and identifier read, and groups one product across stores with the cheapest offer, and a dropdown on the developer tool with a status line and a refresh. A second decision record, with a latency and listing-shape measurement behind it. Then a paid search, under a daily cost cap, used only when the local index holds too little, its results remembered in the index so a repeat search costs nothing. 1213 tests. |
| S-17 | 2026-10-08 | summary | Asked for a review of the unmerged search work and for its loose ends to be cleaned up so it could go to a pull request. Approved the proposed fixes and asked for the pull request. Was walked through every item of the two search decision records, his own and Claude's, and accepted both. | A review of the whole branch with no blockers, then fixes, each with tests: an index refresh that receives an empty product list now removes nothing instead of emptying a store, its cut-off taken from the database's clock rather than the application's, ranking rules moved from the page into the services, and a test in the page layer replaced, under the project's placement rule, by tests of the logic it covered, now in a service and a pure helper. Then a refresh that removes a store's stale rows once, after every one of its product lists is in, and paid searches taken one at a time so two cannot both spend the last search under the daily cap. Notes in the earlier record where the later one overtook it, before both were accepted. 1246 tests. |

## Journeys

One row per journey in [e2e/JOURNEYS.md](../e2e/JOURNEYS.md). `public` publishes the row; `hidden` does not.

| Journey | Treatment | Why hidden |
|---|---|---|
| J-001 | public | |
| J-002 | public | |
| J-003 | public | |
| J-004 | public | |
| J-005 | public | |
| J-006 | public | |
| J-007 | public | |
| J-008 | public | |
| J-009 | public | |
| J-010 | public | |
| J-011 | public | |
| J-012 | hidden | Describes ingestion |
| J-013 | public | |
| J-014 | hidden | The lab page |
| J-015 | hidden | An internal status page |
| J-016 | public | |
| J-017 | hidden | The lab page |
| J-018 | hidden | The lab page |

## Blocklist

Terms that must not appear anywhere in the generated site. The build fails on a match. A new retailer, provider or technique is added here in the session that introduces it.

Matching ignores case, markup, spacing and punctuation, so `JB Hi-Fi` also catches `jbhifi.com.au` and a name split across a line or a tag. A term of fewer than five letters and digits is matched as written, so that `/lab` does not catch "available".

| Kind | Terms |
|---|---|
| Technique | `scrape`, `scraping`, `crawl`, `bot protection`, `headless`, `proxy`, `JSON-LD`, `structured data`, `affiliate`, `predictive search`, `suggest.json` |
| Retailer | `JB`, `JB Hi-Fi`, `Harvey Norman`, `Bing Lee`, `Good Guys`, `Powerland`, `Toptek`, `Betta`, `Videopro`, `Appliance Central`, `Samsung AU` |
| Provider | `SerpApi`, `Google Shopping`, `Gemini`, `Wayback`, `archive.org`, `Shopify`, `Keychain`, `eBay`, `Icecat`, `DataForSEO`, `SearchApi`, `Commission Factory` |
| Internal | `/lab`, `lab page`, `lab status`, `S85H` |
