import { describe, expect, it } from "vitest";

import { assemble, findBlocked } from "./assemble.ts";
import type { AssembleInput } from "./assemble.ts";
import type { ParsedAdr, ParsedComponent } from "./parse.ts";
import { renderMarkdown } from "./render.ts";
import type { Snapshot } from "./types.ts";

const adr = (id: string, over: Partial<ParsedAdr> = {}): ParsedAdr => ({
  id,
  title: `Record ${id}`,
  status: "Accepted",
  date: "2026-09-15",
  decider: "Rafi",
  deciderNote: "proposed by Claude",
  proposedBy: "Claude",
  sections: [{ heading: "Context", markdown: "Private detail about fetching." }],
  optionsRejected: 2,
  ...over,
});

const component = (over: Partial<ParsedComponent> = {}): ParsedComponent => ({
  id: "C-001",
  name: "Schema",
  layer: "Database",
  path: "src/db/schema.ts",
  phase: "1",
  stage: "built",
  decisions: ["0001"],
  isPublic: true,
  ...over,
});

const snapshot: Snapshot = {
  commit: "abc",
  date: "2026-10-01",
  stack: [{ name: "Next.js", role: "Framework", version: "16.3.5" }],
  layers: [],
  migrations: 2,
  tests: null,
  coverage: null,
  journeys: { planned: 2 },
  ciJobs: ["check"],
};

const input = (over: Partial<AssembleInput> = {}): AssembleInput => ({
  metrics: { current: snapshot, history: [] },
  adrs: [adr("0001"), adr("0002")],
  usageLogDates: ["2026-09-15"],
  rules: {
    decisions: [
      { id: "0001", treatment: "full", title: null, summary: null },
      { id: "0002", treatment: "summary", title: "Public title", summary: "Public summary." },
    ],
    sessions: [{ id: "S-01", date: "2026-09-15", treatment: "summary", rafi: "Decided.", claude: "Produced." }],
    journeys: [
      { id: "J-001", treatment: "public" },
      { id: "J-002", treatment: "hidden" },
    ],
    blocklist: ["forbidden"],
  },
  components: [component()],
  journeys: [
    { id: "J-001", journey: "Sign in", actor: "admin", phase: "2", status: "planned" },
    { id: "J-002", journey: "Private", actor: "developer", phase: "1", status: "planned" },
  ],
  phases: [{ id: "1", deliverable: "Backend" }],
  currentPhase: "1",
  commits: [
    { hash: "abc", date: "2026-09-22", author: "rafipinc", area: "db", coAuthor: "Claude Fable 5.1", pullRequest: null },
    { hash: "def", date: "2026-09-23", author: "Someone Else", area: null, coAuthor: null, pullRequest: 4 },
  ],
  pathExists: (path) => path === "src/db/schema.ts",
  generatedAt: "2026-10-01T00:00:00.000Z",
  ...over,
});

describe("assemble", () => {
  it("publishes a full record as rendered sections and a summary record as its summary only", () => {
    const { buildLog, errors } = assemble(input());
    expect(errors).toEqual([]);
    expect(buildLog.decisions[0]).toMatchObject({
      id: "0001",
      title: "Record 0001",
      treatment: "full",
      deciderNote: "proposed by Claude",
      summary: null,
      sections: [{ heading: "Context", html: "<p>Private detail about fetching.</p>" }],
    });
    expect(buildLog.decisions[1]).toMatchObject({
      id: "0002",
      title: "Public title",
      treatment: "summary",
      deciderNote: null,
      summary: "Public summary.",
      sections: [],
      proposedBy: "Claude",
    });
  });

  it("leaves a hidden record out, and out of the components that cite it", () => {
    const base = input();
    const { buildLog, errors } = assemble({
      ...base,
      rules: { ...base.rules, decisions: [{ id: "0001", treatment: "hidden", title: null, summary: null }, base.rules.decisions[1]!] },
    });
    expect(errors).toEqual([]);
    expect(buildLog.decisions.map((d) => d.id)).toEqual(["0002"]);
    expect(buildLog.components[0]?.decisions).toEqual([]);
  });

  it("publishes summary sessions, public components and journeys that are not hidden", () => {
    const base = input();
    const { buildLog } = assemble({
      ...base,
      usageLogDates: ["2026-09-15", "2026-09-17"],
      rules: {
        ...base.rules,
        sessions: [...base.rules.sessions, { id: "S-02", date: "2026-09-17", treatment: "hidden", rafi: "", claude: "" }],
      },
      components: [component(), component({ id: "C-002", isPublic: false })],
    });
    expect(buildLog.sessions).toEqual([{ id: "S-01", date: "2026-09-15", rafi: "Decided.", claude: "Produced." }]);
    expect(buildLog.components.map((c) => c.id)).toEqual(["C-001"]);
    expect(buildLog.journeys.map((j) => j.id)).toEqual(["J-001"]);
  });

  it("shows a commit by any of Rafi's git identities as Rafi and leaves others as they are", () => {
    const { buildLog } = assemble(input());
    expect(buildLog.commits.map((c) => c.author)).toEqual(["Rafi", "Someone Else"]);
  });

  it("fails closed: a record with no row is an error and is not published", () => {
    const { buildLog, errors } = assemble(input({ adrs: [adr("0001"), adr("0002"), adr("0003")] }));
    expect(errors).toEqual(["ADR 0003 has no row in PUBLIC.md"]);
    expect(buildLog.decisions.map((d) => d.id)).toEqual(["0001", "0002"]);
  });

  it.each<[string, Partial<AssembleInput>, string]>([
    ["a rule for a record that does not exist", { adrs: [adr("0001")] }, "PUBLIC.md lists ADR 0002, which does not exist"],
    ["a session count that differs from the usage log", { usageLogDates: ["2026-09-15", "2026-09-17"] }, "PUBLIC.md has 1 session rows but AI_USAGE_LOG.md has 2"],
    ["a session date that differs from the usage log", { usageLogDates: ["2026-09-16"] }, "session S-01 is dated 2026-09-15 but usage log row 1 is dated 2026-09-16"],
    ["a built component whose path is missing", { pathExists: () => false }, 'C-001 is "built" but src/db/schema.ts does not exist'],
    ["a planned component whose path exists", { components: [component({ stage: "planned" })] }, 'C-001 is "planned" but src/db/schema.ts exists'],
    ["a component citing an unknown record", { components: [component({ decisions: ["0099"] })] }, "C-001 cites ADR 0099, which does not exist"],
    ["a journey rule for a journey that does not exist", { journeys: [] }, "PUBLIC.md lists journey J-002, which does not exist"],
  ])("reports %s", (_name, over, message) => {
    expect(assemble(input(over)).errors).toContain(message);
  });

  it("reports a summary record with no summary and a summary session with an empty column", () => {
    const base = input();
    const { errors } = assemble({
      ...base,
      rules: {
        ...base.rules,
        decisions: [base.rules.decisions[0]!, { id: "0002", treatment: "summary", title: null, summary: null }],
        sessions: [{ id: "S-01", date: "2026-09-15", treatment: "summary", rafi: "Decided.", claude: "" }],
      },
    });
    expect(errors).toEqual([
      'ADR 0002 is "summary" in PUBLIC.md but lacks a public title or summary',
      'session S-01 is "summary" but a public column is empty',
    ]);
  });

  it("carries the metrics through and scans them against the blocklist too", () => {
    const history = [{ ...snapshot, commit: "old", ciJobs: ["forbidden job"] }];
    const { buildLog, errors } = assemble(input({ metrics: { current: snapshot, history } }));
    expect(buildLog.metrics.current).toEqual(snapshot);
    expect(errors).toEqual(['blocklisted term "forbidden" at $.metrics.history[0].ciJobs[0]']);
  });

  it("reports a blocklisted term anywhere in the output, whatever its case", () => {
    const base = input();
    const { errors } = assemble({
      ...base,
      rules: { ...base.rules, blocklist: ["FETCHING"] },
    });
    expect(errors).toEqual(['blocklisted term "FETCHING" at $.decisions[0].sections[0].html']);
  });
});

describe("assemble, failing closed", () => {
  it("never publishes the private title of a summary record", () => {
    const base = input();
    const { buildLog, errors } = assemble({
      ...base,
      rules: {
        ...base.rules,
        decisions: [base.rules.decisions[0]!, { id: "0002", treatment: "summary", title: null, summary: "Public summary." }],
      },
    });
    expect(errors).toEqual(['ADR 0002 is "summary" in PUBLIC.md but lacks a public title or summary']);
    expect(buildLog.decisions.map((d) => d.id)).toEqual(["0001"]);
  });

  it("does not publish a journey with no row, and reports it", () => {
    const base = input();
    const { buildLog, errors } = assemble({
      ...base,
      journeys: [...base.journeys, { id: "J-003", journey: "New and private", actor: "developer", phase: "1", status: "planned" }],
    });
    expect(errors).toEqual(["journey J-003 has no row in PUBLIC.md"]);
    expect(buildLog.journeys.map((j) => j.id)).toEqual(["J-001"]);
  });
});

describe("findBlocked", () => {
  it.each([
    ["a name split by markup", "<strong>Big</strong> Shop sells it"],
    ["a name split across a line", "at Big\nShop today"],
    ["a name with different punctuation", "Big-Shop"],
    ["a name inside a link target", '<a href="https://www.bigshop.com.au/x">here</a>'],
  ])("finds %s", (_name, text) => {
    expect(findBlocked(text, ["Big Shop"])).toEqual(['blocklisted term "Big Shop" at $']);
  });

  it("matches a short term as written, so it does not fire inside ordinary words", () => {
    expect(findBlocked("available in a label", ["/lab"])).toEqual([]);
    expect(findBlocked("see /lab for it", ["/lab"])).toEqual(['blocklisted term "/lab" at $']);
  });

  it("walks nested values and ignores non-strings", () => {
    expect(findBlocked({ a: [1, null, { b: "a Bad word" }] }, ["bad"])).toEqual(['blocklisted term "bad" at $.a[2].b']);
    expect(findBlocked({ a: "fine" }, ["bad"])).toEqual([]);
  });
});

describe("renderMarkdown", () => {
  it("reduces an image to its alt text and escapes raw HTML", () => {
    expect(renderMarkdown("![chart](../research/chart.png)")).toBe("<p>chart</p>");
    expect(renderMarkdown('<img src="../research/x.png">')).toBe('&lt;img src=&quot;../research/x.png&quot;&gt;');
  });

  it("turns a link to another record into a site link", () => {
    expect(renderMarkdown("See [ADR-0009](0009-corrections.md) and [it](../adr/0004-gtin.md#decision).")).toBe(
      '<p>See <a href="/decisions/0009/">ADR-0009</a> and <a href="/decisions/0004/">it</a>.</p>',
    );
  });

  it("drops any other relative link to its text and keeps an external one", () => {
    expect(renderMarkdown("The [note](../research/2026-09-15-x.md) and [site](https://example.com).")).toBe(
      '<p>The note and <a href="https://example.com" rel="noreferrer">site</a>.</p>',
    );
  });
});
