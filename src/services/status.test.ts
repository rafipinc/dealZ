import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryDb } from "@/db/queries/db";
import { createTestDb, type TestDb } from "@/db/test-db";
import { SERPAPI_ACCOUNT_ENDPOINT } from "@/sources/serpapi";
import type { FetchLike } from "@/sources";
import { ValidationError } from "./errors";
import { recentCalls } from "./usage";
import { USAGE_WRITE_TIMEOUT_MS } from "./usage-ledger";
import {
  checkServices,
  DATABASE_TIMEOUT_MS,
  safeFailureMessage,
  type CheckServicesInput,
  type ServicesStatus,
} from "./status";

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../sources/fixtures/${name}`, import.meta.url)),
    "utf8",
  );
}

const accountBody = fixture("serpapi-account.json");
const journal = JSON.parse(readFileSync("./drizzle/migrations/meta/_journal.json", "utf8")) as {
  entries: unknown[];
};

const SERP_KEY = "sk-test-0123456789abcdef";
const GEMINI_KEY = "AIzaSy-test-key-0123456789";
const DB_URL = "postgresql://postgres:hunter2@127.0.0.1:54322/postgres";
const FIXED_NOW = new Date("2026-10-01T02:03:04.000Z");

let t: TestDb;

// The application client, for the one test of the default handle.
vi.mock("@/db/client", () => ({
  get db() {
    return t.db;
  },
}));

beforeAll(async () => {
  t = await createTestDb();
});

afterAll(async () => {
  await t.close();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A fetch that fails the test if anything but the account endpoint is asked. */
function accountFetch(respond: () => Response | Promise<Response>, urls: string[] = []): FetchLike {
  return async (url) => {
    urls.push(url);
    if (!url.startsWith(SERPAPI_ACCOUNT_ENDPOINT)) throw new Error(`Unexpected request to ${url}`);
    return respond();
  };
}

const noFetch: FetchLike = async (url) => {
  throw new Error(`Unexpected request to ${url}`);
};

/** A handle whose every query rejects, as a database that is down does. */
function brokenDb(message: string): QueryDb {
  return new Proxy(
    {},
    {
      get() {
        return () => {
          throw new Error(message);
        };
      },
    },
  ) as QueryDb;
}

function check(patch: CheckServicesInput = {}): Promise<ServicesStatus> {
  return checkServices({
    env: {},
    fetch: noFetch,
    db: t.db,
    now: () => FIXED_NOW,
    ...patch,
  });
}

describe("checkServices", () => {
  it("reports everything healthy: database migrated, both keys set, the account's quota", async () => {
    const urls: string[] = [];
    const status = await check({
      env: { GEMINI_API_KEY: GEMINI_KEY, SERPAPI_API_KEY: SERP_KEY },
      fetch: accountFetch(() => new Response(accountBody, { status: 200 }), urls),
    });

    expect(status).toEqual({
      checkedAt: FIXED_NOW,
      database: {
        status: "ok",
        migrationsApplied: journal.entries.length,
        migrationsExpected: journal.entries.length,
        upToDate: true,
      },
      keys: [
        { name: "GEMINI_API_KEY", set: true },
        { name: "SERPAPI_API_KEY", set: true },
      ],
      serpApiAccount: {
        status: "ok",
        planName: "Free Plan",
        searchesPerMonth: 250,
        thisMonthUsage: 38,
        planSearchesLeft: 212,
        totalSearchesLeft: 212,
      },
      usage: { calls: 1, recorded: 1 },
    });
    expect(urls).toHaveLength(1);
  });

  it("never returns a key's value", async () => {
    const status = await check({
      env: { GEMINI_API_KEY: GEMINI_KEY, SERPAPI_API_KEY: SERP_KEY, DATABASE_URL: DB_URL },
      fetch: accountFetch(() => new Response(accountBody, { status: 200 })),
    });
    const text = JSON.stringify(status);
    expect(text).not.toContain(SERP_KEY);
    expect(text).not.toContain(GEMINI_KEY);
    expect(text).not.toContain("hunter2");
  });

  it("reports a key that is absent, empty or blank as not set, and asks SerpApi nothing", async () => {
    for (const env of [{}, { SERPAPI_API_KEY: "" }, { GEMINI_API_KEY: "   " }]) {
      const status = await check({ env });
      expect(status.keys.every((key) => !key.set)).toBe(true);
      expect(status.serpApiAccount).toEqual({ status: "no_key" });
    }
  });

  it("reports the keys one by one", async () => {
    const status = await check({ env: { GEMINI_API_KEY: GEMINI_KEY } });
    expect(status.keys).toEqual([
      { name: "GEMINI_API_KEY", set: true },
      { name: "SERPAPI_API_KEY", set: false },
    ]);
  });

  it("reads process.env and the journal when neither is injected", async () => {
    vi.stubEnv("GEMINI_API_KEY", GEMINI_KEY);
    vi.stubEnv("SERPAPI_API_KEY", "");
    const status = await checkServices({ db: t.db, fetch: noFetch });
    expect(status.keys).toEqual([
      { name: "GEMINI_API_KEY", set: true },
      { name: "SERPAPI_API_KEY", set: false },
    ]);
    expect(status.database).toMatchObject({
      status: "ok",
      migrationsExpected: journal.entries.length,
    });
    expect(status.checkedAt).toBeInstanceOf(Date);
  });

  it("uses the application database when none is injected", async () => {
    const status = await checkServices({ env: {}, fetch: noFetch });
    expect(status.database.status).toBe("ok");
  });

  it("reports a database behind the repository as not up to date", async () => {
    const status = await check({ expectedMigrations: journal.entries.length + 1 });
    expect(status.database).toEqual({
      status: "ok",
      migrationsApplied: journal.entries.length,
      migrationsExpected: journal.entries.length + 1,
      upToDate: false,
    });
  });

  it("reports an unreachable database, with the connection string redacted, and still checks the rest", async () => {
    const status = await check({
      env: { SERPAPI_API_KEY: SERP_KEY, DATABASE_URL: DB_URL },
      db: brokenDb(`connect ECONNREFUSED for ${DB_URL}`),
      fetch: accountFetch(() => new Response(accountBody, { status: 200 })),
      expectedMigrations: 4,
    });

    expect(status.database).toEqual({
      status: "unreachable",
      migrationsExpected: 4,
      message: "connect ECONNREFUSED for REDACTED",
    });
    expect(status.keys).toEqual([
      { name: "GEMINI_API_KEY", set: false },
      { name: "SERPAPI_API_KEY", set: true },
    ]);
    expect(status.serpApiAccount.status).toBe("ok");
  });

  it("reports a failure that is not an Error as its text", async () => {
    const db = new Proxy(
      {},
      {
        get() {
          return () => {
            throw "pool closed";
          };
        },
      },
    ) as QueryDb;
    const status = await check({ db });
    expect(status.database).toMatchObject({ status: "unreachable", message: "pool closed" });
  });

  it("gives the database three seconds by default", () => {
    expect(DATABASE_TIMEOUT_MS).toBe(3_000);
  });

  it("reports a database that never answers as unreachable once the timeout passes, and still checks the rest", async () => {
    // Accepts the query and then says nothing, as a hung host does.
    const silent = new Proxy({}, { get: () => () => new Promise(() => {}) }) as QueryDb;
    const started = Date.now();
    const status = await check({
      env: { SERPAPI_API_KEY: SERP_KEY },
      db: silent,
      databaseTimeoutMs: 20,
      fetch: accountFetch(() => new Response(accountBody, { status: 200 })),
      expectedMigrations: 4,
    });

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(status.database).toEqual({
      status: "unreachable",
      migrationsExpected: 4,
      message: "The database did not answer within 20 ms",
    });
    expect(status.serpApiAccount.status).toBe("ok");
    expect(status.keys).toHaveLength(2);
  });

  it("reports a database that answers the ping and then goes silent as unreachable, not unmigrated", async () => {
    const db = new Proxy(
      {},
      {
        get: (_target, property) =>
          property === "execute" ? async () => [] : () => ({ from: () => new Promise(() => {}) }),
      },
    ) as QueryDb;
    const status = await check({ db, databaseTimeoutMs: 20 });
    expect(status.database).toMatchObject({
      status: "unreachable",
      message: "The database did not answer within 20 ms",
    });
  });

  it("reports a database that answers but was never migrated", async () => {
    const empty = await createTestDb();
    await empty.exec('DROP TABLE "drizzle"."__drizzle_migrations"');
    const status = await check({ db: empty.db, expectedMigrations: 4 });
    await empty.close();

    expect(status.database).toMatchObject({ status: "unmigrated", migrationsExpected: 4 });
  });

  it("reports a SerpApi refusal as a status, without the key, and still checks the database", async () => {
    const status = await check({
      env: { SERPAPI_API_KEY: SERP_KEY },
      fetch: accountFetch(() => new Response("{}", { status: 401 })),
    });
    expect(status.serpApiAccount).toEqual({
      status: "failed",
      kind: "http",
      message: `Request to ${SERPAPI_ACCOUNT_ENDPOINT}?api_key=REDACTED failed: http`,
    });
    expect(status.database.status).toBe("ok");
  });

  it("reports an invalid key, as SerpApi words it, as a failed account check", async () => {
    const status = await check({
      env: { SERPAPI_API_KEY: SERP_KEY },
      fetch: accountFetch(
        () => new Response(JSON.stringify({ error: "Invalid API key." }), { status: 200 }),
      ),
    });
    expect(status.serpApiAccount).toEqual({
      status: "failed",
      kind: "http",
      message: "SerpApi answered: Invalid API key.",
    });
  });

  it("reports a network failure reaching SerpApi as a status, never with the key", async () => {
    const status = await check({
      env: { SERPAPI_API_KEY: SERP_KEY },
      fetch: async (url) => {
        throw new Error(`getaddrinfo ENOTFOUND for ${url}`);
      },
    });
    expect(status.serpApiAccount).toMatchObject({ status: "failed", kind: "network" });
    expect(JSON.stringify(status)).not.toContain(SERP_KEY);
  });

  it("reports everything failing at once, each in its own field", async () => {
    const status = await check({
      env: { SERPAPI_API_KEY: SERP_KEY },
      db: brokenDb("database down"),
      fetch: accountFetch(() => new Response("nope", { status: 500 })),
    });
    expect(status.database.status).toBe("unreachable");
    expect(status.serpApiAccount.status).toBe("failed");
    expect(status.keys).toHaveLength(2);
  });

  describe("the Account call in the usage ledger", () => {
    beforeEach(async () => {
      await t.truncate("api_usage");
    });

    const okFetch = () => accountFetch(() => new Response(accountBody, { status: 200 }));
    const withKey = { SERPAPI_API_KEY: SERP_KEY };

    it("records a successful Account call as one row: serpapi, account, cost 0, no variant", async () => {
      const status = await check({ env: withKey, fetch: okFetch() });

      expect(status.usage).toEqual({ calls: 1, recorded: 1 });
      const rows = await recentCalls(10, { db: t.db });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        provider: "serpapi",
        operation: "account",
        outcome: "ok",
        errorKind: null,
        httpStatus: 200,
        calledAt: FIXED_NOW,
        costMicros: 0,
        priced: true,
        retailerSlug: null,
        variantSlug: null,
      });
      expect(JSON.stringify(rows)).not.toContain(SERP_KEY);
    });

    it("records a failed Account call as a failed row", async () => {
      const status = await check({
        env: withKey,
        fetch: accountFetch(() => new Response("{}", { status: 401 })),
      });
      expect(status.serpApiAccount.status).toBe("failed");
      expect(status.usage).toEqual({ calls: 1, recorded: 1 });
      expect((await recentCalls(10, { db: t.db }))[0]).toMatchObject({
        operation: "account",
        outcome: "failed",
        errorKind: "http",
        httpStatus: 401,
        costMicros: 0,
      });
    });

    it("makes no call and writes no row without a key", async () => {
      const status = await check({ env: {} });
      expect(status.usage).toEqual({ calls: 0, recorded: 0 });
      expect(await recentCalls(10, { db: t.db })).toEqual([]);
    });

    it("hands the call to an injected recorder, with no variant", async () => {
      const recorded: unknown[] = [];
      const status = await check({
        env: withKey,
        fetch: okFetch(),
        recordUsage: async (call) => {
          recorded.push(call);
        },
      });
      expect(recorded).toEqual([
        expect.objectContaining({ provider: "serpapi", operation: "account", variantSlug: null }),
      ]);
      expect(status.usage).toEqual({ calls: 1, recorded: 1 });
      expect(await recentCalls(10, { db: t.db })).toEqual([]);
    });

    it("returns the same statuses when the ledger cannot be written, and says so", async () => {
      const run = (recordUsage?: CheckServicesInput["recordUsage"]) =>
        check({ env: withKey, fetch: okFetch(), recordUsage });
      const { usage: written, ...withLedger } = await run();
      const { usage: lost, ...withoutLedger } = await run(async () => {
        throw new Error("ledger write failed");
      });
      expect(written).toEqual({ calls: 1, recorded: 1 });
      expect(lost).toEqual({ calls: 1, recorded: 0 });
      expect(withoutLedger).toEqual(withLedger);
    });

    it("does not ask an unreachable database to record the call", async () => {
      const recordUsage = vi.fn(async () => undefined);
      const status = await check({
        env: withKey,
        fetch: okFetch(),
        db: brokenDb("database down"),
        recordUsage,
      });
      expect(status.database.status).toBe("unreachable");
      expect(status.serpApiAccount.status).toBe("ok");
      expect(status.usage).toEqual({ calls: 1, recorded: 0 });
      expect(recordUsage).not.toHaveBeenCalled();
    });

    it("returns once the bound passes when the ledger never answers", async () => {
      vi.useFakeTimers();
      try {
        const pending = check({
          env: withKey,
          fetch: okFetch(),
          // The database check must not depend on timers here.
          db: {
            execute: async () => [],
            select: () => ({ from: async () => [{ applied: 4 }] }),
          } as unknown as QueryDb,
          expectedMigrations: 4,
          recordUsage: () => new Promise<never>(() => {}),
        });
        await vi.advanceTimersByTimeAsync(USAGE_WRITE_TIMEOUT_MS);
        const status = await pending;
        expect(status.database.status).toBe("ok");
        expect(status.serpApiAccount.status).toBe("ok");
        expect(status.usage).toEqual({ calls: 1, recorded: 0 });
      } finally {
        vi.useRealTimers();
      }
    });

    it("records on the application database when none is injected", async () => {
      const status = await checkServices({ env: withKey, fetch: okFetch(), now: () => FIXED_NOW });
      expect(status.usage).toEqual({ calls: 1, recorded: 1 });
      expect(await recentCalls(10, { db: t.db })).toHaveLength(1);
    });
  });

  it.each<[string, unknown]>([
    ["an env that is not a record", { env: "production" }],
    ["a recorder that is not a function", { recordUsage: "record" }],
    ["a fetch that is not a function", { fetch: "fetch" }],
    ["a database that is not an object", { db: "postgres://" }],
    ["a clock that is not a function", { now: 12 }],
    ["a negative migration count", { expectedMigrations: -1 }],
    ["a timeout of zero", { databaseTimeoutMs: 0 }],
  ])("rejects %s", async (_name, input) => {
    await expect(checkServices(input as CheckServicesInput)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe("safeFailureMessage", () => {
  it("removes every key and connection string the environment holds", () => {
    const direct = "postgresql://postgres:hunter3@db.example.com:5432/postgres";
    const env = {
      GEMINI_API_KEY: GEMINI_KEY,
      SERPAPI_API_KEY: SERP_KEY,
      DATABASE_URL: DB_URL,
      DIRECT_URL: direct,
    };
    const message = safeFailureMessage(
      new Error(`Failed query against ${DB_URL} (${direct}) with ${SERP_KEY} and ${GEMINI_KEY}`),
      env,
    );
    expect(message).toBe("Failed query against REDACTED (REDACTED) with REDACTED and REDACTED");
  });

  it("reads process.env when no environment is given", () => {
    vi.stubEnv("DATABASE_URL", DB_URL);
    expect(safeFailureMessage(new Error(`connect failed for ${DB_URL}`))).toBe(
      "connect failed for REDACTED",
    );
  });

  it("gives the text of a failure that is not an Error, and leaves a clean message alone", () => {
    expect(safeFailureMessage("pool closed", {})).toBe("pool closed");
    expect(safeFailureMessage(new Error("relation does not exist"), { DATABASE_URL: DB_URL })).toBe(
      "relation does not exist",
    );
  });
});
