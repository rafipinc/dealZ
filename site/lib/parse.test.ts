import { describe, expect, it } from "vitest";

import {
  ParseError,
  parseAdr,
  parseBuildMap,
  parseCurrentPhase,
  parseGitLog,
  parseJourneys,
  parsePhases,
  parsePublic,
  parseUsageLogDates,
  proposerFrom,
  section,
  tableRows,
} from "./parse.ts";

const ADR = `# ADR-0007: History is append-only

**Status:** Accepted
**Date:** 2026-09-17, amended later on 2026-10-01
**Decider:** Rafi (proposed by Claude)

## Context

Why.

## Decision

What, see [ADR-0009](0009-corrections.md).

## Options rejected

- **Convention only.** Fails.
- **Revoke privileges.** Fiddly.
- **Trigger (chosen).** Enforced.

## Consequences

Easier.
`;

describe("tableRows", () => {
  it("returns trimmed cells and drops separator rows", () => {
    expect(tableRows("| A | B |\n|---|:--:|\n| 1 |  |\nnot a row")).toEqual([
      ["A", "B"],
      ["1", ""],
    ]);
  });
});

describe("section", () => {
  it("returns the text under a heading up to the next one", () => {
    expect(section("## One\na\nb\n## Two\nc", /^One$/)).toBe("a\nb");
    expect(section("## One\na\n## Two\nc", /^Two$/)).toBe("c");
  });

  it("returns null when the heading is absent", () => {
    expect(section("## One\na", /^Three$/)).toBeNull();
  });
});

describe("proposerFrom", () => {
  it("credits the decider when there is no note", () => {
    expect(proposerFrom(null)).toBe("Rafi");
  });

  it("reads a single proposer", () => {
    expect(proposerFrom("proposed by Claude")).toBe("Claude");
    expect(proposerFrom("proposed by Rafi")).toBe("Rafi");
  });

  it("reports a joint proposal when both are named", () => {
    expect(proposerFrom("the approach proposed by Rafi, the rules proposed by Claude")).toBe("Rafi and Claude");
  });
});

describe("parseAdr", () => {
  it("reads the header, the sections and the rejected options", () => {
    const adr = parseAdr("0007-append-only.md", ADR);
    expect(adr).toMatchObject({
      id: "0007",
      title: "History is append-only",
      status: "Accepted",
      date: "2026-09-17",
      decider: "Rafi",
      deciderNote: "proposed by Claude",
      proposedBy: "Claude",
      optionsRejected: 2,
    });
    expect(adr.sections.map((s) => s.heading)).toEqual(["Context", "Decision", "Options rejected", "Consequences"]);
    expect(adr.sections[0]?.markdown).toBe("Why.");
  });

  it("reads a decider with no note and a superseded status", () => {
    const adr = parseAdr(
      "0001-x.md",
      "# ADR-0001: X\n\n**Status:** Superseded by ADR-0002\n**Date:** 2026-09-15\n**Decider:** Rafi\n\n## Context\n\nc",
    );
    expect(adr).toMatchObject({ status: "Superseded", deciderNote: null, proposedBy: "Rafi", optionsRejected: null });
  });

  it.each([
    ["notes.md", ADR, "four-digit number"],
    ["0007-x.md", ADR.replace("# ADR-0007:", "# Decision:"), "heading"],
    ["0007-x.md", ADR.replace("Accepted", "Maybe"), "unknown status"],
    ["0007-x.md", ADR.replace("2026-09-17, amended later on 2026-10-01", "last week"), "ISO date"],
    ["0007-x.md", ADR.replace("**Decider:**", "**Owner:**"), "Decider"],
  ])("throws ParseError for %s when the record is malformed (%#)", (file, md, message) => {
    expect(() => parseAdr(file, md)).toThrow(ParseError);
    expect(() => parseAdr(file, md)).toThrow(message);
  });
});

describe("parseUsageLogDates", () => {
  it("returns one date per session row and nothing else from the row", () => {
    const md = "| Date | Rafi's input |\n|---|---|\n| 2026-09-15 | secret |\n| 2026-09-28 (evening) | on 2026-01-01 |";
    expect(parseUsageLogDates(md)).toEqual(["2026-09-15", "2026-09-28"]);
  });
});

const PUBLIC = `# Public allowlist

## Decisions

| ADR | Treatment | Public title | Public summary |
|---|---|---|---|
| 0001 | full | | |
| 0003 | summary | A safe title | A safe summary. |
| 0012 | hidden | | |

## Sessions

| # | Date | Treatment | Rafi | Claude |
|---|---|---|---|---|
| S-01 | 2026-09-15 | summary | Decided. | Produced. |
| S-02 | 2026-09-17 | hidden | | |

## Journeys

| Journey | Treatment | Why hidden |
|---|---|---|
| J-001 | public | |
| J-012 | hidden | Private |

## Blocklist

| Kind | Terms |
|---|---|
| Technique | \`scrape\`, \`bot protection\` |
| Internal | \`/lab\` |
`;

describe("parsePublic", () => {
  it("reads every rule", () => {
    expect(parsePublic(PUBLIC)).toEqual({
      decisions: [
        { id: "0001", treatment: "full", title: null, summary: null },
        { id: "0003", treatment: "summary", title: "A safe title", summary: "A safe summary." },
        { id: "0012", treatment: "hidden", title: null, summary: null },
      ],
      sessions: [
        { id: "S-01", date: "2026-09-15", treatment: "summary", rafi: "Decided.", claude: "Produced." },
        { id: "S-02", date: "2026-09-17", treatment: "hidden", rafi: "", claude: "" },
      ],
      journeys: [
        { id: "J-001", treatment: "public" },
        { id: "J-012", treatment: "hidden" },
      ],
      blocklist: ["scrape", "bot protection", "/lab"],
    });
  });

  it.each([
    [PUBLIC.replace("| 0001 | full |", "| 0001 | everything |"), "unknown treatment"],
    [PUBLIC.replace("| S-01 | 2026-09-15 | summary |", "| S-01 | 2026-09-15 | full |"), "unknown treatment"],
    [PUBLIC.replace("| S-01 | 2026-09-15 |", "| S-01 | soon |"), "no ISO date"],
    [PUBLIC.replace("## Sessions", "## Meetings"), 'missing section "Sessions"'],
    [PUBLIC.replace("| J-012 | hidden |", "| J-012 | Hidden |"), 'journey J-012 has unknown treatment "Hidden"'],
    [PUBLIC.replace("| 0012 | hidden | | |", "| 0001 | hidden | | |"), "0001 has more than one row"],
    [PUBLIC.replace("| S-02 | 2026-09-17 |", "| S-01 | 2026-09-17 |"), "S-01 has more than one row"],
    [PUBLIC.replace("| J-012 | hidden |", "| J-001 | hidden |"), "J-001 has more than one row"],
    [PUBLIC.replace(/\| Technique .*\n\| Internal .*\n/, ""), "blocklist is empty"],
  ])("throws ParseError when the allowlist is malformed (%#)", (md, message) => {
    expect(() => parsePublic(md)).toThrow(ParseError);
    expect(() => parsePublic(md)).toThrow(message);
  });
});

describe("parseBuildMap", () => {
  const row = "| C-001 | `quotes` service | Services | `src/services/quotes.ts` | 1 | spike | 0012, 0013 | yes |";

  it("reads a component row and ignores the stage legend", () => {
    const md = `| Stage | Meaning |\n|---|---|\n| \`planned\` | No code |\n\n| ID | Component |\n|---|---|\n${row}`;
    expect(parseBuildMap(md)).toEqual([
      {
        id: "C-001",
        name: "quotes service",
        layer: "Services",
        path: "src/services/quotes.ts",
        phase: "1",
        stage: "spike",
        decisions: ["0012", "0013"],
        isPublic: true,
      },
    ]);
  });

  it("reads a private row with no decisions", () => {
    expect(parseBuildMap(row.replace("0012, 0013", "").replace("| yes |", "| no |"))[0]).toMatchObject({
      decisions: [],
      isPublic: false,
    });
  });

  it.each([
    [row.replace("spike", "nearly"), "unknown stage"],
    [row.replace("| yes |", "| maybe |"), "yes or no"],
    [row.replace("`src/services/quotes.ts`", ""), "no path"],
  ])("throws ParseError for a malformed row (%#)", (md, message) => {
    expect(() => parseBuildMap(md)).toThrow(ParseError);
    expect(() => parseBuildMap(md)).toThrow(message);
  });
});

describe("parseJourneys", () => {
  it("reads journey rows", () => {
    const md = "| ID | Journey | Actor | Phase | Status | Spec |\n|---|---|---|---|---|---|\n| J-011 | Read `/api/v1/x` | api client | 3 | planned | |";
    expect(parseJourneys(md)).toEqual([
      { id: "J-011", journey: "Read /api/v1/x", actor: "api client", phase: "3", status: "planned" },
    ]);
  });
});

describe("parsePhases", () => {
  const md = "## 9. Security\n\n## 10. Phases\n\n| Phase | Deliverable | Done when |\n|---|---|---|\n| 0 | Docs | private detail |\n| Later | iOS client |\n\n## 11. Open";

  it("reads the phase and the deliverable and leaves the done-when column behind", () => {
    expect(parsePhases(md)).toEqual([
      { id: "0", deliverable: "Docs" },
      { id: "Later", deliverable: "iOS client" },
    ]);
  });

  it("throws ParseError when the section or its rows are missing", () => {
    expect(() => parsePhases("## 1. Purpose")).toThrow(ParseError);
    expect(() => parsePhases("## 10. Phases\n\nNone yet.")).toThrow("no phase rows");
  });
});

describe("parseCurrentPhase", () => {
  it("reads the phase number", () => {
    expect(parseCurrentPhase("**Updated:** 2026-10-01. **Phase:** 1, backend.")).toBe("1");
  });

  it("throws ParseError when it is missing", () => {
    expect(() => parseCurrentPhase("# Status")).toThrow(ParseError);
  });
});

describe("parseGitLog", () => {
  const record = (fields: string[]) => `${fields.join("\x1f")}\x1e\n`;

  it("keeps the area, never the subject, and reads the co-author", () => {
    const raw = record(["abc1234", "2026-09-22T10:00:00+10:00", "rafi", "db: add secret thing", "Claude Fable 5.1 <noreply@anthropic.com>"]);
    expect(parseGitLog(raw)).toEqual([
      { hash: "abc1234", date: "2026-09-22", author: "rafi", area: "db", coAuthor: "Claude Fable 5.1", pullRequest: null },
    ]);
  });

  it("reads a pull request merge without its branch name", () => {
    const raw = record(["def5678", "2026-09-24T09:00:00+10:00", "rafipinc", "Merge pull request #2 from rafipinc/p1/secret", ""]);
    expect(parseGitLog(raw)).toEqual([
      { hash: "def5678", date: "2026-09-24", author: "rafipinc", area: null, coAuthor: null, pullRequest: 2 },
    ]);
  });

  it("returns nothing for an empty log and null area for a subject without a prefix", () => {
    expect(parseGitLog("")).toEqual([]);
    expect(parseGitLog(record(["a", "2026-01-01T00:00:00Z", "x", "Initial commit", ""]))[0]?.area).toBeNull();
  });

  it("drops a prefix that is not a known area, since it is free text from the subject", () => {
    expect(parseGitLog(record(["a", "2026-01-01T00:00:00Z", "x", "someshop: add reader", ""]))[0]?.area).toBeNull();
  });
});
