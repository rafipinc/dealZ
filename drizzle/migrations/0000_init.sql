CREATE TYPE "public"."deal_status" AS ENUM('draft', 'published', 'expired', 'retracted');--> statement-breakpoint
CREATE TYPE "public"."identifier_type" AS ENUM('gtin', 'mpn', 'retailer_sku');--> statement-breakpoint
CREATE TYPE "public"."listing_condition" AS ENUM('new', 'refurbished_manufacturer', 'refurbished_seller', 'factory_second', 'display_model', 'open_box', 'used', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."match_method" AS ENUM('manual', 'gtin', 'mpn', 'title', 'llm');--> statement-breakpoint
CREATE TYPE "public"."observation_source" AS ENUM('manual', 'scrape', 'api');--> statement-breakpoint
CREATE TABLE "deal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"price_observation_id" uuid NOT NULL,
	"title" text NOT NULL,
	"commentary" text,
	"status" "deal_status" DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deal_published_has_timestamp" CHECK ("deal"."status" <> 'published' OR "deal"."published_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "identifier" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"variant_id" uuid NOT NULL,
	"type" "identifier_type" NOT NULL,
	"value" text NOT NULL,
	"retailer_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identifier_type_value_retailer_uq" UNIQUE NULLS NOT DISTINCT("type","value","retailer_id"),
	CONSTRAINT "identifier_retailer_only_for_sku" CHECK (("identifier"."type" = 'retailer_sku') = ("identifier"."retailer_id" IS NOT NULL)),
	CONSTRAINT "identifier_gtin_is_14_digits" CHECK ("identifier"."type" <> 'gtin' OR "identifier"."value" ~ '^[0-9]{14}$')
);
--> statement-breakpoint
CREATE TABLE "listing" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"variant_id" uuid NOT NULL,
	"retailer_id" uuid NOT NULL,
	"canonical_url" text NOT NULL,
	"retailer_sku" text,
	"retailer_title" text,
	"condition" "listing_condition" DEFAULT 'unknown' NOT NULL,
	"condition_confidence" real DEFAULT 0 NOT NULL,
	"condition_notes" text,
	"warranty_months" integer,
	"match_method" "match_method" NOT NULL,
	"match_confidence" real DEFAULT 1 NOT NULL,
	"matched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "listing_retailer_url_uq" UNIQUE("retailer_id","canonical_url"),
	CONSTRAINT "listing_condition_confidence_range" CHECK ("listing"."condition_confidence" BETWEEN 0 AND 1),
	CONSTRAINT "listing_match_confidence_range" CHECK ("listing"."match_confidence" BETWEEN 0 AND 1)
);
--> statement-breakpoint
CREATE TABLE "price_observation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"price_cents" integer NOT NULL,
	"currency" text DEFAULT 'AUD' NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" "observation_source" NOT NULL,
	"confidence" real DEFAULT 1 NOT NULL,
	"supersedes_id" uuid,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_observation_price_non_negative" CHECK ("price_observation"."price_cents" >= 0),
	CONSTRAINT "price_observation_confidence_range" CHECK ("price_observation"."confidence" BETWEEN 0 AND 1),
	CONSTRAINT "price_observation_currency_iso4217" CHECK ("price_observation"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "product" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"brand" text NOT NULL,
	"series" text NOT NULL,
	"category" text NOT NULL,
	"release_year" integer,
	"display_name" text NOT NULL,
	"image_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_slug_unique" UNIQUE("slug"),
	CONSTRAINT "product_brand_series_year_uq" UNIQUE NULLS NOT DISTINCT("brand","series","release_year"),
	CONSTRAINT "product_slug_format" CHECK ("product"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
--> statement-breakpoint
CREATE TABLE "retailer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"domain" text NOT NULL,
	"platform" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retailer_slug_unique" UNIQUE("slug"),
	CONSTRAINT "retailer_domain_unique" UNIQUE("domain"),
	CONSTRAINT "retailer_slug_format" CHECK ("retailer"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
--> statement-breakpoint
CREATE TABLE "variant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"size" text,
	"colour" text,
	"region" text NOT NULL,
	"rrp_cents" integer,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "variant_product_slug_uq" UNIQUE("product_id","slug"),
	CONSTRAINT "variant_slug_format" CHECK ("variant"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "variant_region_iso3166" CHECK ("variant"."region" ~ '^[A-Z]{2}$'),
	CONSTRAINT "variant_rrp_non_negative" CHECK ("variant"."rrp_cents" IS NULL OR "variant"."rrp_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "deal" ADD CONSTRAINT "deal_price_observation_id_price_observation_id_fk" FOREIGN KEY ("price_observation_id") REFERENCES "public"."price_observation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identifier" ADD CONSTRAINT "identifier_variant_id_variant_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identifier" ADD CONSTRAINT "identifier_retailer_id_retailer_id_fk" FOREIGN KEY ("retailer_id") REFERENCES "public"."retailer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing" ADD CONSTRAINT "listing_variant_id_variant_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variant"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing" ADD CONSTRAINT "listing_retailer_id_retailer_id_fk" FOREIGN KEY ("retailer_id") REFERENCES "public"."retailer"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_observation" ADD CONSTRAINT "price_observation_listing_id_listing_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listing"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_observation" ADD CONSTRAINT "price_observation_supersedes_id_price_observation_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."price_observation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant" ADD CONSTRAINT "variant_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deal_status_published_idx" ON "deal" USING btree ("status","published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "deal_observation_idx" ON "deal" USING btree ("price_observation_id");--> statement-breakpoint
CREATE INDEX "identifier_variant_idx" ON "identifier" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "listing_variant_idx" ON "listing" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "price_observation_listing_time_idx" ON "price_observation" USING btree ("listing_id","observed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "price_observation_supersedes_idx" ON "price_observation" USING btree ("supersedes_id") WHERE "price_observation"."supersedes_id" IS NOT NULL;