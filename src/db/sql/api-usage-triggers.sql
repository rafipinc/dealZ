-- Postgres behaviour for api_usage that Drizzle cannot express in schema.ts.
--
-- Applied once through the custom migration 0003_api-usage-triggers.sql. This
-- file and that migration must stay identical (cmp the two). triggers.sql is
-- paired with 0001_triggers.sql in the same way and is not touched here, since
-- an applied migration is never edited.
--
-- The statement-breakpoint marker lines between statements are Drizzle's
-- separator. Never put one inside a $$ function body, and never write the full
-- marker inside a comment.

-- ---------------------------------------------------------------------------
-- 1. api_usage is append-only (ADR-0014, proposed).
--    The ledger records what was called and what it cost. Nothing edits or
--    removes a row. Same shape and ERRCODE as price_observation_append_only.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION reject_api_usage_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'api_usage is append-only (% not allowed)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER api_usage_append_only
  BEFORE UPDATE OR DELETE ON api_usage
  FOR EACH ROW
  EXECUTE FUNCTION reject_api_usage_mutation();
