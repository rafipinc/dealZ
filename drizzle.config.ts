import { defineConfig } from "drizzle-kit";

// Migrations run over the direct connection, never the transaction pooler.
// SETUP.md section 3 explains why.
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle/migrations",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DIRECT_URL! },
  schemaFilter: ["public"], // never touch Supabase's auth and storage schemas
});
