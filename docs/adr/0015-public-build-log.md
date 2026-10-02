# ADR-0015: A public build log, generated from the repository, as a separate project with a default-deny allowlist

**Status:** Accepted (2026-10-02)
**Date:** 2026-10-01
**Decider:** Rafi (the idea, the separate project and the public scope decided by Rafi; the registry, the allowlist and the checks proposed by Claude)

## Context

DealZ is a portfolio piece first (WORKING_RULES.md). ADR-0011 put the evidence of how it is built into the repository: the ADR decider lines, the AI usage log, the commit trailers. A reader still has to open a dozen Markdown files to see it. On 2026-10-01 Rafi asked for a web view of the development workflow for prospective employers and other outside readers: how each thing is built, the stage it is at, the key architecture decisions and where a human made the call. It must update itself from the files, run locally first and move to Vercel later.

Two constraints came from Rafi the same day. The lab page must never be public. The site shows the architecture and the development process, not how prices are fetched from retailers.

The existing documents do not meet those constraints as written. The usage log, STATUS.md, the research notes, ADR-0012 and ADR-0013 name retailers, providers and techniques. And no document states the stage of each component in a form a script can read; STATUS.md is prose.

## Decision

1. **A separate project in `site/`.** Its own `package.json`, built as a static export. No server code, no environment secrets, no import from `src/`. It cannot serve the lab page or any server action because it contains none. It deploys later as its own Vercel project (planned).
2. **The site holds no content of its own.** A generator script reads `docs/adr/`, `docs/AI_USAGE_LOG.md`, `docs/BUILD_MAP.md`, `docs/PUBLIC.md`, `docs/ARCHITECTURE.md` section 10, `e2e/JOURNEYS.md` and the git history, and writes one JSON file that the pages render. It runs before `dev` and before `build`, so a new session, decision or commit appears on the next build with no extra step.
3. **`docs/BUILD_MAP.md` is the registry of components and their stage.** One row per component: layer, path, phase, stage, the ADRs behind it and whether it is public. Stages are `planned`, `spike`, `built`, `tested`, `shipped`, `retired`. A CI check compares the registry with the code, as the journey check does for end-to-end specs.
4. **`docs/PUBLIC.md` is a default-deny allowlist.** Every ADR, every session and every journey has a row. A journey is `public` or `hidden`. An ADR is `full`, `summary` or `hidden`. A session is `summary` or `hidden`. A summary is hand-written for the public reader and approved by Rafi. Anything without a row is not published, and CI fails until it has one.
5. **A blocklist is the second guard.** `docs/PUBLIC.md` lists terms that must not appear in the generated output: retailer names, provider names, fetching techniques. The build fails on a match.
6. **Human involvement is shown from the record, not asserted.** Each decision carries its decider and its proposer, parsed from the ADR's Decider line. Each session carries what Rafi decided and what Claude produced. Proposed ADRs are shown as awaiting Rafi. Commits show date, area, author and co-author; subjects are not shown.
7. **CI records the stack and the implementation once per green push to `main`** (decided by Rafi on 2026-10-01, so the history follows the commits; a push of several commits records its head). After the gate is green, a `metrics` job collects one snapshot: the versions of the listed stack packages, modules and test files per layer, the migration count, test totals, coverage, journeys by status and the CI job names. It appends the snapshot as one line to `metrics.jsonl` on the `build-log-data` branch. The generator reads that file as the history and computes the current commit's snapshot itself. The stack list is an allowlist in `site/lib/metrics.ts`; a dependency not named there is never published. Snapshots hold counts and versions, never file names.
8. **The end-of-session protocol gains one step.** The session's row in `docs/PUBLIC.md` is written with the usage log row and confirmed by Rafi in the recap.

## Options rejected

- **A `/build` route inside the app.** One deploy, but the public site would share a deployment with the lab page and the API keys. A separate static project removes the risk instead of guarding against it.
- **Publish the documents verbatim.** No upkeep, but it publishes exactly what Rafi ruled out.
- **Derive each component's stage from signals only** (files exist, tests exist). No upkeep, but it cannot tell a spike from finished work, and "planned" has no file to detect.
- **A blocklist alone.** A new retailer or provider would be public until someone added its name. Default-deny fails closed.
- **Run the tests at site build time for the metrics.** Always current, but it gives one number, not a history, and slows every build. Recording in CI gives a snapshot per commit.
- **CI commits the snapshots to `main`.** A bot commit after every merge, in the same history it describes. A separate data branch keeps `main` to human-requested commits.
- **Commit the generated JSON.** Works on any host, but every change carries a generated diff. Generation at build time needs the full git history, which is a deploy setting.
- **A portfolio page written by hand at the end.** Already rejected in ADR-0011: it drifts, and it asserts involvement instead of showing the record.

## Consequences

- Easier: an outside reader sees the decisions, the stages and who decided in one place, current as of the last build.
- Harder: two more registries to keep honest and one more line to write per session. The CI checks catch a missing row; they cannot judge whether a summary says too much. That stays with Rafi at the recap.
- The repository itself is public on GitHub, so the full documents are readable there. The allowlist governs what the site presents, not what exists. Whether the repository stays public is a separate decision for Rafi.
- `site/` is outside the layer rules of ARCHITECTURE.md section 3: it is not part of the product and imports nothing from it. Its generator and parsers carry their own tests.
- Planned, in order: the generator and the two checks, then the pages, then the Vercel deploy with full git history enabled.
- Revisit at the end of phase 1. If the build map is never out of step with the code, its check can become a warning.
