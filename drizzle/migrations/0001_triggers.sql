-- Postgres behaviour that Drizzle cannot express in schema.ts.
--
-- Applied once through a custom migration:
--   npx drizzle-kit generate --custom --name triggers
--   then paste this whole file into the generated drizzle/migrations/000N_triggers.sql
-- See docs/SETUP.md. This file and the applied migration must stay identical.
--
-- The statement-breakpoint marker lines between statements are Drizzle's
-- separator. They let the migrator run one statement at a time, which PGlite
-- (used in tests) requires. Never put one inside a $$ function body, and never
-- write the full marker inside a comment: the migrator splits on it wherever
-- it appears.

-- ---------------------------------------------------------------------------
-- 1. price_observation is append-only (ADR-0007).
--    Nothing edits or removes a fact. Corrections are new rows (ADR-0009).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION reject_price_observation_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'price_observation is append-only (% not allowed)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER price_observation_append_only
  BEFORE UPDATE OR DELETE ON price_observation
  FOR EACH ROW
  EXECUTE FUNCTION reject_price_observation_mutation();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. A correction must supersede an observation on the same listing (ADR-0009).
--    The foreign key guarantees the target exists; this guards the listing.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION check_price_observation_supersedes()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_listing uuid;
BEGIN
  IF NEW.supersedes_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT listing_id INTO target_listing
    FROM price_observation
   WHERE id = NEW.supersedes_id;

  IF target_listing IS NOT NULL AND target_listing <> NEW.listing_id THEN
    RAISE EXCEPTION 'a correction must stay on the same listing (observation % is on listing %, correction is on listing %)',
      NEW.supersedes_id, target_listing, NEW.listing_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER price_observation_supersedes_same_listing
  BEFORE INSERT ON price_observation
  FOR EACH ROW
  EXECUTE FUNCTION check_price_observation_supersedes();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. updated_at is maintained by the database, so edits made outside the app
--    (Drizzle Studio, psql) are covered too.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER retailer_set_updated_at BEFORE UPDATE ON retailer FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER product_set_updated_at  BEFORE UPDATE ON product  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER variant_set_updated_at  BEFORE UPDATE ON variant  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER listing_set_updated_at  BEFORE UPDATE ON listing  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER deal_set_updated_at     BEFORE UPDATE ON deal     FOR EACH ROW EXECUTE FUNCTION set_updated_at();
