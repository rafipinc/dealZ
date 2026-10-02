// Reads the repository's own documents and git history and writes generated/build-log.json,
// the only thing the pages render. Runs before `dev` and `build`. Policy: docs/adr/0014.
//
// Fails, writing nothing, when:
//   - a document does not parse
//   - an ADR or session has no row in docs/PUBLIC.md, or a row points at nothing
//   - docs/BUILD_MAP.md disagrees with the code (a built path missing, a planned path present)
//   - the output contains a term from the blocklist
//
// Also reads the stack and implementation metrics: the current commit's from the working
// tree, and the per-commit history that CI records on the `build-log-data` branch.
//
// Usage: node scripts/generate.ts [--check]     --check validates and writes nothing

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { assemble } from "../lib/assemble.ts";
import {
  GIT_LOG_FORMAT,
  ParseError,
  parseAdr,
  parseBuildMap,
  parseCurrentPhase,
  parseGitLog,
  parseJourneys,
  parsePhases,
  parsePublic,
  parseUsageLogDates,
} from "../lib/parse.ts";
import { parseHistory } from "../lib/metrics.ts";
import type { Snapshot } from "../lib/types.ts";
import { collectSnapshot } from "./snapshot.ts";

const siteDir = resolve(import.meta.dirname, "..");
const root = resolve(siteDir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" });

/**
 * The snapshots CI has recorded, one per green push to main, from metrics.jsonl on the
 * `build-log-data` branch. Empty until the first push to main after that job exists.
 */
function readHistory(): Snapshot[] {
  for (const ref of ["origin/build-log-data", "build-log-data"]) {
    try {
      const jsonl = execFileSync("git", ["show", `${ref}:metrics.jsonl`], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      return parseHistory(jsonl);
    } catch (error) {
      if (error instanceof ParseError) throw error;
    }
  }
  console.warn("build log: no build-log-data branch found, the metrics history is empty");
  return [];
}

function main(): number {
  const checkOnly = process.argv.includes("--check");

  const adrs = readdirSync(join(root, "docs/adr"))
    .filter((name) => /^\d{4}-.*\.md$/.test(name))
    .sort()
    .map((name) => parseAdr(name, read(`docs/adr/${name}`)));

  if (git("rev-parse", "--is-shallow-repository").trim() === "true") {
    console.warn("build log: shallow clone, the commit history will be incomplete");
  }

  const { buildLog, errors } = assemble({
    metrics: { current: collectSnapshot(root, { testOutput: false }), history: readHistory() },
    adrs,
    usageLogDates: parseUsageLogDates(read("docs/AI_USAGE_LOG.md")),
    rules: parsePublic(read("docs/PUBLIC.md")),
    components: parseBuildMap(read("docs/BUILD_MAP.md")),
    journeys: parseJourneys(read("e2e/JOURNEYS.md")),
    phases: parsePhases(read("docs/ARCHITECTURE.md")),
    currentPhase: parseCurrentPhase(read("docs/STATUS.md")),
    commits: parseGitLog(git("log", `--format=${GIT_LOG_FORMAT}`)),
    pathExists: (path) => existsSync(join(root, path)),
    generatedAt: new Date().toISOString(),
  });

  if (errors.length > 0) {
    console.error(`build log: ${errors.length} problem(s)`);
    for (const error of errors) console.error(`  - ${error}`);
    return 1;
  }

  const summary = `${buildLog.decisions.length} decisions, ${buildLog.sessions.length} sessions, ${buildLog.components.length} components, ${buildLog.commits.length} commits`;
  if (checkOnly) {
    console.log(`build log: OK, ${summary}`);
    return 0;
  }
  mkdirSync(join(siteDir, "generated"), { recursive: true });
  writeFileSync(join(siteDir, "generated/build-log.json"), `${JSON.stringify(buildLog, null, 2)}\n`);
  console.log(`build log: wrote generated/build-log.json, ${summary}`);
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  if (!(error instanceof ParseError)) throw error;
  console.error(`build log: ${error.message}`);
  process.exitCode = 1;
}
