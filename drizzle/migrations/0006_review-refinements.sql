ALTER TABLE "product" DROP CONSTRAINT "product_brand_series_year_uq";--> statement-breakpoint
ALTER TABLE "catalogue_candidate" ADD COLUMN "retailer_name" text;--> statement-breakpoint
ALTER TABLE "catalogue_candidate" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "catalogue_candidate" ADD COLUMN "via" text DEFAULT 'storefront' NOT NULL;--> statement-breakpoint
ALTER TABLE "catalogue_candidate" ADD COLUMN "inspected_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "product_brand_series_year_ci_uq" ON "product" USING btree (lower("brand"),lower("series"),coalesce("release_year", 0));--> statement-breakpoint
ALTER TABLE "catalogue_candidate" ADD CONSTRAINT "catalogue_candidate_gtin_not_placeholder" CHECK ("catalogue_candidate"."gtin" IS NULL OR "catalogue_candidate"."gtin" !~ '^([0-9])\1{13}$');--> statement-breakpoint
ALTER TABLE "catalogue_candidate" ADD CONSTRAINT "catalogue_candidate_category_format" CHECK ("catalogue_candidate"."category" IS NULL OR "catalogue_candidate"."category" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');--> statement-breakpoint
ALTER TABLE "catalogue_candidate" ADD CONSTRAINT "catalogue_candidate_via_known" CHECK ("catalogue_candidate"."via" IN ('storefront', 'google_shopping'));--> statement-breakpoint
ALTER TABLE "identifier" ADD CONSTRAINT "identifier_gtin_not_placeholder" CHECK ("identifier"."type" <> 'gtin' OR "identifier"."value" !~ '^([0-9])\1{13}$');--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_category_format" CHECK ("product"."category" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');--> statement-breakpoint
-- Relabel the Google Shopping rows already in a developer's index. They were
-- written by a search with the SerpApi result as raw, which carries a source
-- key and a product_id or product_link; storefront rows carry neither. The
-- index is disposable (ADR-0017 item 9), so this is for correctness, not
-- survival.
UPDATE "catalogue_candidate" SET "via" = 'google_shopping' WHERE "source" = 'search' AND "raw" ? 'source' AND ("raw" ? 'product_id' OR "raw" ? 'product_link');
