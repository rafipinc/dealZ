// The application client is replaced, so no connection is opened: the test
// is about when the module is loaded and what is handed back, not the database.

import { describe, expect, it, vi } from "vitest";

const loaded = vi.hoisted(() => ({ times: 0, db: { name: "application database" } }));

vi.mock("@/db/client", () => {
  loaded.times += 1;
  return { db: loaded.db };
});

describe("defaultDb", () => {
  it("does not load the database client until it is asked for", async () => {
    await import("./default-db");
    expect(loaded.times).toBe(0);
  });

  it("returns the application database, loading the client once however often it is asked", async () => {
    const { defaultDb } = await import("./default-db");
    expect(await defaultDb()).toBe(loaded.db);
    expect(await defaultDb()).toBe(loaded.db);
    expect(loaded.times).toBe(1);
  });
});
