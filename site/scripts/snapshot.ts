// Reads the files a Snapshot is made from. Shared by collect-metrics.ts (CI, once per
// commit on main) and generate.ts (the current commit, at build time).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ciJobNames,
  coverageTotals,
  journeyCounts,
  layerCounts,
  migrationCount,
  stackFrom,
  testTotals,
} from "../lib/metrics.ts";
import { parseJourneys } from "../lib/parse.ts";
import type { Snapshot } from "../lib/types.ts";

/**
 * `testOutput` says whether coverage/ holds the output of a test run of this very commit.
 * True in the `metrics` CI job, which downloads it from the gate. False at build time,
 * where whatever is lying in coverage/ may belong to an older commit.
 */
export function collectSnapshot(root: string, { testOutput }: { testOutput: boolean }): Snapshot {
  const read = (path: string): string => readFileSync(join(root, path), "utf8");
  const readIfPresent = (path: string): string | null => (existsSync(join(root, path)) ? read(path) : null);
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" });

  const [commit = "", isoDate = ""] = git("log", "-1", "--format=%h%x1f%aI").trim().split("\x1f");
  // Tracked files only, so a snapshot depends on the commit and on nothing lying around.
  const files = git("ls-files").split("\n");

  // Written by `npm test` (vitest.config.mts).
  const tests = testOutput ? readIfPresent("coverage/test-results.json") : null;
  const coverage = testOutput ? readIfPresent("coverage/coverage-summary.json") : null;

  return {
    commit,
    date: isoDate.slice(0, 10),
    stack: stackFrom(read("package.json"), readIfPresent("package-lock.json")),
    layers: layerCounts(files),
    migrations: migrationCount(files),
    tests: tests === null ? null : testTotals(tests),
    coverage: coverage === null ? null : coverageTotals(coverage),
    journeys: journeyCounts(parseJourneys(read("e2e/JOURNEYS.md"))),
    ciJobs: ciJobNames(read(".github/workflows/ci.yml")),
  };
}
