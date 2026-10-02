// The application database handle, loaded on first use. Importing
// src/db/client opens a connection pool, so a service that only sometimes
// needs the database (and every test that injects its own) must not pay for
// it at import time.

import type { QueryDb } from "@/db/queries/db";

export async function defaultDb(): Promise<QueryDb> {
  const { db } = await import("@/db/client");
  return db;
}
