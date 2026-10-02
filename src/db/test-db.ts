// PGlite harness for database tests: an in-process Postgres with the real
// migrations from drizzle/migrations applied, so tests meet the same
// constraints and triggers as production. Test-only; nothing in the app
// imports this.

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "./schema";

const MIGRATIONS_FOLDER = "./drizzle/migrations";

export async function createTestDb() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

  return {
    db,
    /** Raw SQL, for statements a test must be free to get wrong. */
    exec: (statement: string) => client.query(statement),
    /** Empties the given tables. TRUNCATE, never DELETE: row triggers do not fire. */
    truncate: (...tables: string[]) =>
      client.query(`TRUNCATE ${tables.map((t) => `"${t}"`).join(", ")} CASCADE`),
    close: () => client.close(),
  };
}

export type TestDb = Awaited<ReturnType<typeof createTestDb>>;
