CREATE TABLE "catalogue_candidate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"retailer_slug" text NOT NULL,
	"handle" text NOT NULL,
	"canonical_url" text NOT NULL,
	"title" text NOT NULL,
	"brand" text,
	"store_type" text,
	"mpn" text,
	"gtin" text,
	"retailer_sku" text,
	"price_cents" integer,
	"compare_at_cents" integer,
	"currency" text DEFAULT 'AUD' NOT NULL,
	"available" boolean,
	"image_url" text,
	"source" text NOT NULL,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalogue_candidate_retailer_handle_uq" UNIQUE("retailer_slug","handle"),
	CONSTRAINT "catalogue_candidate_retailer_slug_format" CHECK ("catalogue_candidate"."retailer_slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "catalogue_candidate_gtin_is_14_digits" CHECK ("catalogue_candidate"."gtin" IS NULL OR "catalogue_candidate"."gtin" ~ '^[0-9]{14}$'),
	CONSTRAINT "catalogue_candidate_price_non_negative" CHECK ("catalogue_candidate"."price_cents" IS NULL OR "catalogue_candidate"."price_cents" >= 0),
	CONSTRAINT "catalogue_candidate_compare_at_non_negative" CHECK ("catalogue_candidate"."compare_at_cents" IS NULL OR "catalogue_candidate"."compare_at_cents" >= 0),
	CONSTRAINT "catalogue_candidate_currency_iso4217" CHECK ("catalogue_candidate"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "catalogue_candidate_source_known" CHECK ("catalogue_candidate"."source" IN ('listing', 'search', 'inspect'))
);
--> statement-breakpoint
CREATE INDEX "catalogue_candidate_gtin_idx" ON "catalogue_candidate" USING btree ("gtin");--> statement-breakpoint
CREATE INDEX "catalogue_candidate_mpn_idx" ON "catalogue_candidate" USING btree ("mpn");