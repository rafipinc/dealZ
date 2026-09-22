import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// The app connects through Supabase's transaction pooler, which shares one
// server connection across clients per statement. Prepared statements do not
// survive that, so they are off. Migrations use DIRECT_URL instead.
const sql = postgres(process.env.DATABASE_URL!, { prepare: false });

export const db = drizzle(sql, { schema });
export type Db = typeof db;
