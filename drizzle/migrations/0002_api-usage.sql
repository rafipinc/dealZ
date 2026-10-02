CREATE TYPE "public"."api_call_outcome" AS ENUM('ok', 'failed');--> statement-breakpoint
CREATE TABLE "api_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"operation" text NOT NULL,
	"called_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome" "api_call_outcome" NOT NULL,
	"error_kind" text,
	"http_status" integer,
	"duration_ms" integer NOT NULL,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_micros" integer DEFAULT 0 NOT NULL,
	"retailer_slug" text,
	"variant_slug" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_usage_provider_format" CHECK ("api_usage"."provider" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "api_usage_error_kind_only_when_failed" CHECK (("api_usage"."outcome" = 'failed') = ("api_usage"."error_kind" IS NOT NULL)),
	CONSTRAINT "api_usage_duration_non_negative" CHECK ("api_usage"."duration_ms" >= 0),
	CONSTRAINT "api_usage_input_tokens_non_negative" CHECK ("api_usage"."input_tokens" IS NULL OR "api_usage"."input_tokens" >= 0),
	CONSTRAINT "api_usage_output_tokens_non_negative" CHECK ("api_usage"."output_tokens" IS NULL OR "api_usage"."output_tokens" >= 0),
	CONSTRAINT "api_usage_cost_non_negative" CHECK ("api_usage"."cost_micros" >= 0)
);
--> statement-breakpoint
CREATE INDEX "api_usage_provider_time_idx" ON "api_usage" USING btree ("provider","called_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "api_usage_time_idx" ON "api_usage" USING btree ("called_at" DESC NULLS LAST);