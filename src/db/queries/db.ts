import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type * as schema from "../schema";

// The database handle every query helper takes. It is the driver-neutral base
// of both the postgres-js instance in ../client.ts and the PGlite instance the
// tests build, so a helper runs unchanged against either.
export type QueryDb = PgDatabase<PgQueryResultHKT, typeof schema>;
