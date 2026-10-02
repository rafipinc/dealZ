import { describe, expect, it } from "vitest";

import {
  ciJobNames,
  coverageTotals,
  journeyCounts,
  layerCounts,
  migrationCount,
  parseHistory,
  stackFrom,
  testTotals,
} from "./metrics.ts";
import { ParseError } from "./parse.ts";

describe("stackFrom", () => {
  const pkg = JSON.stringify({
    dependencies: { next: "16.3.5", zod: "^4.6.5", "some-private-sdk": "1.0.0" },
    devDependencies: { vitest: "~5.0.1" },
  });

  it("prefers the installed version from the lockfile", () => {
    const lock = JSON.stringify({ packages: { "node_modules/zod": { version: "4.6.9" } } });
    expect(stackFrom(pkg, lock)).toEqual([
      { name: "Next.js", role: "Framework", version: "16.3.5" },
      { name: "Zod", role: "Validation at boundaries", version: "4.6.9" },
      { name: "Vitest", role: "Unit and database tests", version: "5.0.1" },
    ]);
  });

  it("falls back to the declared range without a lockfile", () => {
    expect(stackFrom(pkg, null).map((item) => item.version)).toEqual(["16.3.5", "4.6.5", "5.0.1"]);
  });

  it("never publishes a dependency that is not on the list", () => {
    expect(JSON.stringify(stackFrom(pkg, null))).not.toContain("private");
  });

  it("returns nothing for a package with no dependencies and throws on invalid JSON", () => {
    expect(stackFrom("{}", null)).toEqual([]);
    expect(() => stackFrom("{", null)).toThrow(ParseError);
    expect(() => stackFrom("{}", "nope")).toThrow("package-lock.json");
  });
});

describe("layerCounts and migrationCount", () => {
  const files = [
    "src/lib/gtin.ts",
    "src/lib/gtin.test.ts",
    "src/sources/http.ts",
    "src/sources/fixtures/page.ts",
    "src/sources/fixtures/page.json",
    "src/app/page.tsx",
    "src/db/CLAUDE.md",
    "drizzle/migrations/0000_init.sql",
    "drizzle/migrations/meta/_journal.json",
    "site/lib/parse.ts",
  ];

  it("counts modules and test files per layer, leaving out fixtures and other file types", () => {
    expect(layerCounts(files)).toEqual([
      { layer: "Database", path: "src/db/", modules: 0, testFiles: 0 },
      { layer: "Services", path: "src/services/", modules: 0, testFiles: 0 },
      { layer: "Sources", path: "src/sources/", modules: 1, testFiles: 0 },
      { layer: "Adapters", path: "src/app/", modules: 1, testFiles: 0 },
      { layer: "Shared", path: "src/lib/", modules: 1, testFiles: 1 },
    ]);
  });

  it("counts SQL migrations and not their metadata", () => {
    expect(migrationCount(files)).toBe(1);
  });
});

describe("testTotals", () => {
  it("reads the totals from a Vitest JSON report", () => {
    const report = JSON.stringify({ numTotalTests: 12, numPassedTests: 11, testResults: [{}, {}] });
    expect(testTotals(report)).toEqual({ files: 2, total: 12, passed: 11 });
  });

  it("throws ParseError for anything else", () => {
    expect(() => testTotals("{}")).toThrow("not a Vitest JSON report");
    expect(() => testTotals("<html>")).toThrow(ParseError);
  });
});

describe("coverageTotals", () => {
  const total = { lines: { pct: 99.1 }, branches: { pct: 92 }, functions: { pct: 100 }, statements: { pct: 98.5 } };

  it("reads the four percentages", () => {
    expect(coverageTotals(JSON.stringify({ total }))).toEqual({ lines: 99.1, branches: 92, functions: 100, statements: 98.5 });
  });

  it("throws ParseError when a percentage is missing", () => {
    expect(() => coverageTotals(JSON.stringify({ total: { ...total, branches: {} } }))).toThrow("total.branches.pct");
    expect(() => coverageTotals("[]")).toThrow(ParseError);
  });
});

describe("ciJobNames", () => {
  it("reads each job's name, or its id when it has none, and stops at the end of the jobs block", () => {
    const yaml = [
      "name: CI",
      "on:",
      "  push:",
      "jobs:",
      "  check:",
      "    name: Typecheck, lint, tests",
      "    steps:",
      "      - run: npm test",
      "  e2e:",
      "    runs-on: ubuntu-latest",
      "env:",
      "  other:",
    ].join("\n");
    expect(ciJobNames(yaml)).toEqual(["Typecheck, lint, tests", "e2e"]);
  });

  it("returns nothing for a workflow with no jobs", () => {
    expect(ciJobNames("name: CI")).toEqual([]);
  });
});

describe("journeyCounts", () => {
  it("counts journeys by status", () => {
    const journey = (status: string) => ({ id: "J-001", journey: "x", actor: "a", phase: "1", status });
    expect(journeyCounts([journey("planned"), journey("planned"), journey("covered")])).toEqual({ planned: 2, covered: 1 });
    expect(journeyCounts([])).toEqual({});
  });
});

describe("parseHistory", () => {
  it("reads one snapshot per line and skips blank lines", () => {
    const line = (commit: string) => JSON.stringify({ commit, date: "2026-10-01", stack: [] });
    expect(parseHistory(`${line("abc")}\n\n${line("def")}\n`).map((s) => s.commit)).toEqual(["abc", "def"]);
    expect(parseHistory("")).toEqual([]);
  });

  it("throws ParseError, naming the line, for a line that is not a snapshot", () => {
    expect(() => parseHistory('{"commit":"abc","date":"2026-10-01"}\nnot json')).toThrow("line 2");
    expect(() => parseHistory('{"date":"2026-10-01"}')).toThrow(ParseError);
  });
});
