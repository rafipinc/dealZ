import { describe, expect, it } from "vitest";
import { SYDNEY } from "./day-ranges";
import {
  ledgerBlockedReason,
  ledgerReadFailure,
  toStatusView,
  type StatusInput,
} from "./status-view";

const NOW = new Date("2026-10-01T01:00:00.000Z");

const healthy: StatusInput = {
  checkedAt: NOW,
  database: { status: "ok", migrationsApplied: 4, migrationsExpected: 4, upToDate: true },
  keys: [
    { name: "GEMINI_API_KEY", set: true },
    { name: "SERPAPI_API_KEY", set: false },
  ],
  serpApiAccount: {
    status: "ok",
    planName: "Free Plan",
    searchesPerMonth: 250,
    thisMonthUsage: 38,
    planSearchesLeft: 212,
    totalSearchesLeft: 212,
  },
};

const view = (status: StatusInput) => toStatusView(status, SYDNEY);

describe("toStatusView", () => {
  it("prints the check time in the zone it is given", () => {
    // 01:00 UTC on 1 October is noon in Sydney, daylight time not yet begun: 11:00.
    expect(toStatusView(healthy, SYDNEY).checkedAtLabel).toMatch(/11:00:00/);
    expect(toStatusView(healthy, "UTC").checkedAtLabel).toMatch(/1:00:00/);
  });

  it("shows a migrated database as reachable with its counts", () => {
    expect(view(healthy).database).toEqual({
      tone: "good",
      badge: "reachable",
      detail: "4 of 4 migrations applied.",
      note: null,
    });
  });

  it("shows a database behind the repository as out of date, with what to run", () => {
    const shown = view({
      ...healthy,
      database: { status: "ok", migrationsApplied: 0, migrationsExpected: 1, upToDate: false },
    });
    expect(shown.database).toEqual({
      tone: "warn",
      badge: "out of date",
      detail: "Reachable, but 0 of 1 migration applied.",
      note: "Run npm run db:migrate.",
    });
  });

  it("shows an unmigrated database as its own state, with the database's message", () => {
    const shown = view({
      ...healthy,
      database: { status: "unmigrated", migrationsExpected: 4, message: "relation missing" },
    });
    expect(shown.database.tone).toBe("warn");
    expect(shown.database.badge).toBe("not migrated");
    expect(shown.database.note).toContain("relation missing");
    expect(shown.database.note).toContain("npm run db:migrate");
  });

  it("shows an unreachable database with the redacted message it was given", () => {
    const shown = view({
      ...healthy,
      database: {
        status: "unreachable",
        migrationsExpected: 4,
        message: "connect ECONNREFUSED for REDACTED",
      },
    });
    expect(shown.database).toEqual({
      tone: "bad",
      badge: "unreachable",
      detail: "The database did not answer.",
      note: "connect ECONNREFUSED for REDACTED",
    });
  });

  it("shows keys as set or not set and nothing else", () => {
    expect(view(healthy).keys).toEqual([
      { name: "GEMINI_API_KEY", tone: "good", badge: "set" },
      { name: "SERPAPI_API_KEY", tone: "muted", badge: "not set" },
    ]);
  });

  it("shows the plan, the share of the allowance used and what is left", () => {
    expect(view(healthy).serpApiAccount).toEqual({
      tone: "good",
      badge: "Free Plan",
      detail: "38 of 250 searches used this month (15%), 212 left.",
      note: null,
    });
  });

  it("warns when no search is left", () => {
    const shown = view({
      ...healthy,
      serpApiAccount: {
        status: "ok",
        planName: "Free Plan",
        searchesPerMonth: 250,
        thisMonthUsage: 250,
        planSearchesLeft: 0,
        totalSearchesLeft: 0,
      },
    });
    expect(shown.serpApiAccount.tone).toBe("warn");
    expect(shown.serpApiAccount.detail).toBe("250 of 250 searches used this month (100%), 0 left.");
  });

  it.each([
    [
      "no allowance",
      { searchesPerMonth: null, thisMonthUsage: 38, totalSearchesLeft: null },
      "38 searches used this month.",
    ],
    [
      "no usage",
      { searchesPerMonth: 250, thisMonthUsage: null, totalSearchesLeft: 212 },
      "Usage this month is not reported, 212 left.",
    ],
    [
      "an allowance of zero",
      { searchesPerMonth: 0, thisMonthUsage: 0, totalSearchesLeft: 5 },
      "0 of 0 searches used this month, 5 left.",
    ],
  ])("words an account that reports %s without inventing a number", (_name, patch, detail) => {
    const shown = view({
      ...healthy,
      serpApiAccount: { status: "ok", planName: "Plan", planSearchesLeft: null, ...patch },
    });
    expect(shown.serpApiAccount.detail).toBe(detail);
  });

  it("shows a missing key and a failed account check as their own states", () => {
    expect(view({ ...healthy, serpApiAccount: { status: "no_key" } }).serpApiAccount).toMatchObject(
      { tone: "muted", badge: "no key" },
    );
    expect(
      view({
        ...healthy,
        serpApiAccount: {
          status: "failed",
          kind: "http",
          message: "SerpApi answered: Invalid API key.",
        },
      }).serpApiAccount,
    ).toEqual({
      tone: "bad",
      badge: "http",
      detail: "SerpApi did not return the account.",
      note: "SerpApi answered: Invalid API key.",
    });
  });
});

describe("ledgerBlockedReason", () => {
  it("is null for a database that answers, even one behind on migrations", () => {
    expect(ledgerBlockedReason(healthy.database)).toBeNull();
    expect(
      ledgerBlockedReason({
        status: "ok",
        migrationsApplied: 3,
        migrationsExpected: 4,
        upToDate: false,
      }),
    ).toBeNull();
  });

  it("says why for an unreachable or unmigrated database", () => {
    expect(
      ledgerBlockedReason({ status: "unreachable", migrationsExpected: 4, message: "refused" }),
    ).toBe("The database is unreachable, so the ledger cannot be read: refused");
    expect(
      ledgerBlockedReason({ status: "unmigrated", migrationsExpected: 4, message: "x" }),
    ).toContain("npm run db:migrate");
  });
});

describe("ledgerReadFailure", () => {
  it("prefixes the redacted message it is given and adds nothing else", () => {
    expect(ledgerReadFailure("connect failed for REDACTED")).toBe(
      "The ledger could not be read: connect failed for REDACTED",
    );
  });
});
