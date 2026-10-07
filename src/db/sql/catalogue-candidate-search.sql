-- Postgres behaviour for catalogue_candidate that Drizzle cannot express in
-- schema.ts (ADR-0017, proposed).
--
-- Applied once through the custom migration 0005_catalogue-candidate-search.sql.
-- This file and that migration must stay identical (cmp the two). The earlier
-- pairs (triggers.sql, api-usage-triggers.sql) are not touched here, since an
-- applied migration is never edited.
--
-- The statement-breakpoint marker lines between statements are Drizzle's
-- separator. Never put one inside a $$ function body, and never write the full
-- marker inside a comment.

-- ---------------------------------------------------------------------------
-- 1. Trigram search over titles. The extension must exist before the index,
--    which is why neither sits in the generated 0004_catalogue-candidate.sql.
--    pg_trgm is available on Supabase and in PGlite (contrib/pg_trgm).
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX catalogue_candidate_title_trgm_idx
  ON catalogue_candidate USING gin (title gin_trgm_ops);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. updated_at is maintained by the database, as on every mutable table.
--    set_updated_at() is defined in 0001_triggers.sql.
-- ---------------------------------------------------------------------------

CREATE TRIGGER catalogue_candidate_set_updated_at
  BEFORE UPDATE ON catalogue_candidate
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
