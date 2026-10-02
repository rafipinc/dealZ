// Applies the allowlist (docs/PUBLIC.md) to the parsed documents and returns the public
// build log together with every rule that was broken. Pure: the caller supplies file
// existence and the clock. Default deny: nothing reaches the output without a row.

import { renderMarkdown } from "./render.ts";
import type {
  ParsedAdr,
  ParsedCommit,
  ParsedComponent,
  ParsedJourney,
  PublicRules,
} from "./parse.ts";
import type { BuildLog, Decision, Metrics } from "./types.ts";

export interface AssembleInput {
  metrics: Metrics;
  adrs: ParsedAdr[];
  usageLogDates: string[];
  rules: PublicRules;
  components: ParsedComponent[];
  journeys: ParsedJourney[];
  phases: { id: string; deliverable: string }[];
  currentPhase: string;
  commits: ParsedCommit[];
  pathExists: (path: string) => boolean;
  generatedAt: string;
}

export interface AssembleResult {
  buildLog: BuildLog;
  errors: string[];
}

const PATH_REQUIRED = new Set(["spike", "built", "tested", "shipped"]);

const squash = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Whether a term occurs in a string of the output. A term is compared with markup, spacing
 * and punctuation removed from both sides, so a name split by a tag, a line break or a
 * hyphen, or buried in a domain, still matches. A term too short for that (it would match
 * inside ordinary words) is compared as written, against the text with and without its tags.
 */
function containsTerm(value: string, term: string): boolean {
  const withoutTags = value.replace(/<[^>]*>/g, "");
  const squashed = squash(term);
  if (squashed.length >= 5) return squash(withoutTags).includes(squashed) || squash(value).includes(squashed);
  const needle = term.toLowerCase();
  return withoutTags.toLowerCase().includes(needle) || value.toLowerCase().includes(needle);
}

/** Every blocklisted term found in any string of the value, with where it was found. */
export function findBlocked(value: unknown, blocklist: string[], path = "$"): string[] {
  if (typeof value === "string") {
    return blocklist
      .filter((term) => containsTerm(value, term))
      .map((term) => `blocklisted term "${term}" at ${path}`);
  }
  if (Array.isArray(value)) return value.flatMap((item, i) => findBlocked(item, blocklist, `${path}[${i}]`));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => findBlocked(item, blocklist, `${path}.${key}`));
  }
  return [];
}

export function assemble(input: AssembleInput): AssembleResult {
  const errors: string[] = [];
  const { rules } = input;

  // Decisions: every record needs a rule, every rule a record.
  const adrIds = new Set(input.adrs.map((adr) => adr.id));
  for (const rule of rules.decisions) {
    if (!adrIds.has(rule.id)) errors.push(`PUBLIC.md lists ADR ${rule.id}, which does not exist`);
  }
  const decisions: Decision[] = [];
  for (const adr of input.adrs) {
    const rule = rules.decisions.find((r) => r.id === adr.id);
    if (!rule) {
      errors.push(`ADR ${adr.id} has no row in PUBLIC.md`);
      continue;
    }
    if (rule.treatment === "hidden") continue;
    // A summary record publishes nothing of its own, not even its title.
    if (rule.treatment === "summary" && (!rule.summary || !rule.title)) {
      errors.push(`ADR ${adr.id} is "summary" in PUBLIC.md but lacks a public title or summary`);
      continue;
    }
    const full = rule.treatment === "full";
    decisions.push({
      id: adr.id,
      title: full ? adr.title : (rule.title ?? ""),
      status: adr.status,
      date: adr.date,
      decider: adr.decider,
      proposedBy: adr.proposedBy,
      treatment: rule.treatment,
      deciderNote: full ? adr.deciderNote : null,
      summary: full ? null : rule.summary,
      sections: full ? adr.sections.map((s) => ({ heading: s.heading, html: renderMarkdown(s.markdown) })) : [],
      optionsRejected: adr.optionsRejected,
    });
  }
  const publishedIds = new Set(decisions.map((d) => d.id));

  // Sessions: one rule per usage log row, in the same order, on the same date.
  if (rules.sessions.length !== input.usageLogDates.length) {
    errors.push(
      `PUBLIC.md has ${rules.sessions.length} session rows but AI_USAGE_LOG.md has ${input.usageLogDates.length}`,
    );
  }
  rules.sessions.forEach((rule, i) => {
    const logDate = input.usageLogDates[i];
    if (logDate !== undefined && logDate !== rule.date) {
      errors.push(`session ${rule.id} is dated ${rule.date} but usage log row ${i + 1} is dated ${logDate}`);
    }
    if (rule.treatment === "summary" && (!rule.rafi || !rule.claude)) {
      errors.push(`session ${rule.id} is "summary" but a public column is empty`);
    }
  });
  const sessions = rules.sessions
    .filter((rule) => rule.treatment === "summary")
    .map(({ id, date, rafi, claude }) => ({ id, date, rafi, claude }));

  // Components: the registry must agree with the code.
  for (const component of input.components) {
    const exists = input.pathExists(component.path);
    if (PATH_REQUIRED.has(component.stage) && !exists) {
      errors.push(`${component.id} is "${component.stage}" but ${component.path} does not exist`);
    }
    if (!PATH_REQUIRED.has(component.stage) && exists) {
      errors.push(`${component.id} is "${component.stage}" but ${component.path} exists`);
    }
    for (const id of component.decisions) {
      if (!adrIds.has(id)) errors.push(`${component.id} cites ADR ${id}, which does not exist`);
    }
  }
  const components = input.components
    .filter((component) => component.isPublic)
    .map(({ id, name, layer, path, phase, stage, decisions: cited }) => ({
      id,
      name,
      layer,
      path,
      phase,
      stage,
      decisions: cited.filter((d) => publishedIds.has(d)),
    }));

  // Journeys: every journey needs a rule, every rule a journey. Only `public` is published.
  const journeyIds = new Set(input.journeys.map((j) => j.id));
  for (const rule of rules.journeys) {
    if (!journeyIds.has(rule.id)) errors.push(`PUBLIC.md lists journey ${rule.id}, which does not exist`);
  }
  const journeys = input.journeys.filter((journey) => {
    const rule = rules.journeys.find((r) => r.id === journey.id);
    if (!rule) errors.push(`journey ${journey.id} has no row in PUBLIC.md`);
    return rule?.treatment === "public";
  });

  const commits = input.commits.map((commit) => ({
    hash: commit.hash,
    date: commit.date,
    area: commit.area,
    author: /^rafi/i.test(commit.author) ? "Rafi" : commit.author,
    coAuthor: commit.coAuthor,
    pullRequest: commit.pullRequest,
  }));

  const buildLog: BuildLog = {
    metrics: input.metrics,
    generatedAt: input.generatedAt,
    currentPhase: input.currentPhase,
    phases: input.phases,
    decisions,
    sessions,
    components,
    journeys,
    commits,
  };

  errors.push(...findBlocked(buildLog, rules.blocklist));
  return { buildLog, errors };
}
