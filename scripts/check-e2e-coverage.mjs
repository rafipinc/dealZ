#!/usr/bin/env node
// Checks e2e/JOURNEYS.md against the spec files in e2e/. Policy: docs/TESTING.md.
//
// Fails when:
//   - a journey row has an unknown status or a duplicate ID
//   - a `required` or `covered` journey has no spec, or its spec does not mention the ID
//   - a `planned` or `retired` journey has a spec file
//   - a spec file exists that no journey row names
//
// Usage: node scripts/check-e2e-coverage.mjs [repo root]
// No dependencies, so it runs before `npm ci` and in any CI job.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const e2eDir = join(root, "e2e");
const registryPath = join(e2eDir, "JOURNEYS.md");
const STATUSES = new Set(["planned", "required", "covered", "retired"]);
const NEEDS_SPEC = new Set(["required", "covered"]);

const errors = [];

if (!existsSync(registryPath)) {
  console.error(`e2e coverage: missing ${relative(root, registryPath)}`);
  process.exit(1);
}

const rows = readFileSync(registryPath, "utf8")
  .split("\n")
  .filter((line) => /^\|\s*J-\d{3}\s*\|/.test(line))
  .map((line) => {
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    const [id, journey, actor, phase, status, spec = ""] = cells;
    return { id, journey, actor, phase, status, spec: spec.replace(/^`|`$/g, "") };
  });

function specFiles(dir) {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== "fixtures" && name !== "node_modules") found.push(...specFiles(path));
    } else if (name.endsWith(".spec.ts")) {
      found.push(path);
    }
  }
  return found;
}

const seen = new Set();
const claimed = new Set();

for (const row of rows) {
  const where = `${row.id} (${row.journey})`;
  if (seen.has(row.id)) errors.push(`${where}: duplicate ID`);
  seen.add(row.id);

  if (!STATUSES.has(row.status)) {
    errors.push(`${where}: unknown status "${row.status}"; expected one of ${[...STATUSES].join(", ")}`);
    continue;
  }

  const specPath = row.spec ? join(e2eDir, row.spec) : null;
  const specExists = specPath ? existsSync(specPath) : false;
  if (specPath) claimed.add(resolve(specPath));

  if (NEEDS_SPEC.has(row.status)) {
    if (!row.spec) errors.push(`${where}: status ${row.status} but no spec named; add e2e/${row.id}-<slug>.spec.ts and fill the Spec column`);
    else if (!specExists) errors.push(`${where}: spec e2e/${row.spec} does not exist`);
    else if (!readFileSync(specPath, "utf8").includes(row.id)) errors.push(`${where}: e2e/${row.spec} does not mention ${row.id}; put the ID in the top-level test.describe title`);
  } else if (specExists) {
    errors.push(`${where}: status ${row.status} but e2e/${row.spec} exists; set the status to required, or delete the spec`);
  }
}

for (const file of specFiles(e2eDir)) {
  const abs = resolve(file);
  if (!claimed.has(abs)) {
    const idInName = relative(e2eDir, file).match(/J-\d{3}/)?.[0];
    const hint = idInName && seen.has(idInName) ? `set ${idInName}'s Spec column to ${relative(e2eDir, file)}` : "add a row to e2e/JOURNEYS.md";
    errors.push(`e2e/${relative(e2eDir, file)}: no journey names this spec; ${hint}`);
  }
}

const counts = Object.fromEntries([...STATUSES].map((status) => [status, rows.filter((row) => row.status === status).length]));
const summary = `${rows.length} journeys (${Object.entries(counts).map(([status, count]) => `${count} ${status}`).join(", ")}), ${claimed.size} specs`;

if (errors.length > 0) {
  console.error(`e2e coverage: FAIL, ${summary}`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(`e2e coverage: OK, ${summary}`);
