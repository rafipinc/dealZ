// Pure parsers: one repository document in, typed rows out. No file or network access.
// A document that drifts from its expected shape throws ParseError, which fails the build.

import { STAGES } from "./types.ts";
import type { DecisionStatus, Proposer, Stage } from "./types.ts";

export class ParseError extends Error {
  readonly file: string;

  constructor(file: string, message: string) {
    super(`${file}: ${message}`);
    this.name = "ParseError";
    this.file = file;
  }
}

const ISO_DATE = /\d{4}-\d{2}-\d{2}/;

/** Cells of every Markdown table row, without the separator rows. */
export function tableRows(md: string): string[][] {
  return md
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|"))
    .map((line) =>
      line
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim()),
    )
    .filter((cells) => !cells.every((cell) => /^:?-+:?$/.test(cell)));
}

/** The text under a `## ` heading, up to the next one. Null when the heading is absent. */
export function section(md: string, heading: RegExp): string | null {
  const lines = md.split("\n");
  const start = lines.findIndex((line) => line.startsWith("## ") && heading.test(line.slice(3).trim()));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
}

function requireSection(file: string, md: string, heading: RegExp, name: string): string {
  const text = section(md, heading);
  if (text === null) throw new ParseError(file, `missing section "${name}"`);
  return text;
}

const stripTicks = (text: string): string => text.replace(/`/g, "");

export interface ParsedAdr {
  id: string;
  title: string;
  status: DecisionStatus;
  date: string;
  decider: string;
  deciderNote: string | null;
  proposedBy: Proposer;
  sections: { heading: string; markdown: string }[];
  optionsRejected: number | null;
}

/** Who proposed a decision, from the note in the Decider line. No note means the decider did. */
export function proposerFrom(note: string | null): Proposer {
  if (note === null) return "Rafi";
  const claude = /by Claude/i.test(note);
  const rafi = /by Rafi/i.test(note);
  if (claude && rafi) return "Rafi and Claude";
  return claude ? "Claude" : "Rafi";
}

export function parseAdr(filename: string, md: string): ParsedAdr {
  const id = /^(\d{4})-/.exec(filename)?.[1];
  if (!id) throw new ParseError(filename, "filename does not start with a four-digit number");

  const title = /^# ADR-\d{4}:\s*(.+)$/m.exec(md)?.[1]?.trim();
  if (!title) throw new ParseError(filename, "missing `# ADR-NNNN: Title` heading");

  const statusText = /^\*\*Status:\*\*\s*(.+)$/m.exec(md)?.[1]?.trim();
  const status = (["Proposed", "Accepted", "Superseded"] as const).find((s) => statusText?.startsWith(s));
  if (!status) throw new ParseError(filename, `unknown status "${statusText ?? ""}"`);

  const date = ISO_DATE.exec(/^\*\*Date:\*\*\s*(.+)$/m.exec(md)?.[1] ?? "")?.[0];
  if (!date) throw new ParseError(filename, "missing ISO date in the Date line");

  const deciderLine = /^\*\*Decider:\*\*\s*(.+)$/m.exec(md)?.[1]?.trim();
  if (!deciderLine) throw new ParseError(filename, "missing Decider line");
  const paren = deciderLine.indexOf("(");
  const decider = (paren === -1 ? deciderLine : deciderLine.slice(0, paren)).trim();
  const deciderNote = paren === -1 ? null : deciderLine.slice(paren + 1).replace(/\)\s*$/, "").trim();

  const sections = md
    .split(/^## /m)
    .slice(1)
    .map((block) => {
      const newline = block.indexOf("\n");
      return {
        heading: (newline === -1 ? block : block.slice(0, newline)).trim(),
        markdown: newline === -1 ? "" : block.slice(newline + 1).trim(),
      };
    });

  const rejected = sections.find((s) => /^options rejected$/i.test(s.heading));
  const bullets = (rejected?.markdown ?? "")
    .split("\n")
    .filter((line) => line.startsWith("- ") && !line.includes("(chosen)")).length;
  // A record that argues its options in prose has no bullets to count.
  const optionsRejected = bullets > 0 ? bullets : null;

  return { id, title, status, date, decider, deciderNote, proposedBy: proposerFrom(deciderNote), sections, optionsRejected };
}

/** Only the dates of the usage log rows. The rows themselves are private and never leave this function. */
export function parseUsageLogDates(md: string): string[] {
  return tableRows(md)
    .map((cells) => (cells[0] ? ISO_DATE.exec(cells[0]) : null))
    .filter((match): match is RegExpExecArray => match !== null && match.index === 0)
    .map((match) => match[0]);
}

export interface PublicDecisionRule {
  id: string;
  treatment: "full" | "summary" | "hidden";
  title: string | null;
  summary: string | null;
}

export interface PublicSessionRule {
  id: string;
  date: string;
  treatment: "summary" | "hidden";
  rafi: string;
  claude: string;
}

export interface PublicJourneyRule {
  id: string;
  treatment: "public" | "hidden";
}

export interface PublicRules {
  decisions: PublicDecisionRule[];
  sessions: PublicSessionRule[];
  journeys: PublicJourneyRule[];
  blocklist: string[];
}

export function parsePublic(md: string): PublicRules {
  const file = "docs/PUBLIC.md";

  const decisions = tableRows(requireSection(file, md, /^Decisions$/, "Decisions"))
    .filter((cells) => /^\d{4}$/.test(cells[0] ?? ""))
    .map((cells): PublicDecisionRule => {
      const [id = "", treatment = "", title = "", summary = ""] = cells;
      if (treatment !== "full" && treatment !== "summary" && treatment !== "hidden") {
        throw new ParseError(file, `ADR ${id} has unknown treatment "${treatment}"`);
      }
      return { id, treatment, title: title || null, summary: summary || null };
    });

  const sessions = tableRows(requireSection(file, md, /^Sessions$/, "Sessions"))
    .filter((cells) => /^S-\d+$/.test(cells[0] ?? ""))
    .map((cells): PublicSessionRule => {
      const [id = "", date = "", treatment = "", rafi = "", claude = ""] = cells;
      if (treatment !== "summary" && treatment !== "hidden") {
        throw new ParseError(file, `session ${id} has unknown treatment "${treatment}"`);
      }
      if (!ISO_DATE.test(date)) throw new ParseError(file, `session ${id} has no ISO date`);
      return { id, date, treatment, rafi, claude };
    });

  const journeys = tableRows(requireSection(file, md, /^Journeys$/, "Journeys"))
    .filter((cells) => /^J-\d{3}$/.test(cells[0] ?? ""))
    .map((cells): PublicJourneyRule => {
      const [id = "", treatment = ""] = cells;
      if (treatment !== "public" && treatment !== "hidden") {
        throw new ParseError(file, `journey ${id} has unknown treatment "${treatment}"`);
      }
      return { id, treatment };
    });

  // The first of two rows would win silently, so a `full` row could mask a later `hidden` one.
  for (const ids of [decisions, sessions, journeys].map((rows) => rows.map((row) => row.id))) {
    const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
    if (duplicate) throw new ParseError(file, `${duplicate} has more than one row`);
  }

  const blocklist = tableRows(requireSection(file, md, /^Blocklist$/, "Blocklist"))
    .slice(1)
    .flatMap((cells) => [...(cells[1] ?? "").matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? ""))
    .filter((term) => term.length > 0);
  if (blocklist.length === 0) throw new ParseError(file, "the blocklist is empty");

  return { decisions, sessions, journeys, blocklist };
}

export interface ParsedComponent {
  id: string;
  name: string;
  layer: string;
  path: string;
  phase: string;
  stage: Stage;
  decisions: string[];
  isPublic: boolean;
}

export function parseBuildMap(md: string): ParsedComponent[] {
  const file = "docs/BUILD_MAP.md";
  return tableRows(md)
    .filter((cells) => /^C-\d{3}$/.test(cells[0] ?? ""))
    .map((cells): ParsedComponent => {
      const [id = "", name = "", layer = "", path = "", phase = "", stage = "", decisions = "", isPublic = ""] = cells;
      const known = STAGES.find((s) => s === stage);
      if (!known) throw new ParseError(file, `${id} has unknown stage "${stage}"`);
      if (isPublic !== "yes" && isPublic !== "no") throw new ParseError(file, `${id} Public must be yes or no`);
      if (!path) throw new ParseError(file, `${id} has no path`);
      return {
        id,
        name: stripTicks(name),
        layer,
        path: stripTicks(path),
        phase,
        stage: known,
        decisions: decisions.match(/\d{4}/g) ?? [],
        isPublic: isPublic === "yes",
      };
    });
}

export interface ParsedJourney {
  id: string;
  journey: string;
  actor: string;
  phase: string;
  status: string;
}

export function parseJourneys(md: string): ParsedJourney[] {
  return tableRows(md)
    .filter((cells) => /^J-\d{3}$/.test(cells[0] ?? ""))
    .map((cells) => {
      const [id = "", journey = "", actor = "", phase = "", status = ""] = cells;
      return { id, journey: stripTicks(journey), actor, phase, status };
    });
}

/** Phase and deliverable only. The "Done when" column names things the public log does not show. */
export function parsePhases(architectureMd: string): { id: string; deliverable: string }[] {
  const file = "docs/ARCHITECTURE.md";
  const phases = tableRows(requireSection(file, architectureMd, /^\d+\.\s*Phases$/, "Phases"))
    .filter((cells) => /^(\d+|Later)$/.test(cells[0] ?? ""))
    .map((cells) => ({ id: cells[0] ?? "", deliverable: cells[1] ?? "" }));
  if (phases.length === 0) throw new ParseError(file, "no phase rows found");
  return phases;
}

export function parseCurrentPhase(statusMd: string): string {
  const phase = /\*\*Phase:\*\*\s*(\d+)/.exec(statusMd)?.[1];
  if (!phase) throw new ParseError("docs/STATUS.md", "missing `**Phase:** N`");
  return phase;
}

export interface ParsedCommit {
  hash: string;
  date: string;
  author: string;
  area: string | null;
  coAuthor: string | null;
  pullRequest: number | null;
}

/** The format `git log` must be called with for parseGitLog. Fields end with 0x1f, records with 0x1e. */
export const GIT_LOG_FORMAT = "%h%x1f%aI%x1f%an%x1f%s%x1f%(trailers:key=Co-Authored-By,valueonly,separator=%x2C)%x1e";

/** The subject prefixes of the root CLAUDE.md, plus the two layers added since. */
const COMMIT_AREAS = new Set(["db", "services", "sources", "app", "lib", "test", "e2e", "docs", "ci", "site"]);

export function parseGitLog(raw: string): ParsedCommit[] {
  return raw
    .split("\x1e")
    .map((record) => record.trim())
    .filter((record) => record.length > 0)
    .map((record) => {
      const [hash = "", isoDate = "", author = "", subject = "", trailer = ""] = record.split("\x1f");
      const merge = /^Merge pull request #(\d+)/.exec(subject);
      // Only a known area is kept. Any other prefix is free text from the subject.
      const prefix = /^([a-z0-9-]+):/.exec(subject)?.[1];
      const area = !merge && prefix && COMMIT_AREAS.has(prefix) ? prefix : null;
      const coAuthor = trailer.split(",")[0]?.replace(/<[^>]*>/, "").trim() || null;
      return { hash, date: isoDate.slice(0, 10), author, area, coAuthor, pullRequest: merge ? Number(merge[1]) : null };
    });
}
