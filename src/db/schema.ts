// DealZ data model. Single source of truth for the database.
//
// `drizzle-kit generate` turns this file into SQL migrations. Behaviour that
// Drizzle cannot express (triggers) lives in ./sql/triggers.sql and is applied
// through a custom migration. docs/DATA_MODEL.md explains the reasoning behind
// each table; docs/SETUP.md covers the migration workflow.
//
// Conventions
// - uuid primary keys, timestamptz everywhere, integer cents for money.
// - Every invariant Postgres can enforce is enforced here (unique, check) or in
//   sql/triggers.sql. Application code is the second line of defence.
// - Mutable tables carry updated_at, maintained by trigger.

import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

// ---------- Enums ----------
// Closed sets only. Open sets (category, platform) stay text.

export const identifierType = pgEnum("identifier_type", ["gtin", "mpn", "retailer_sku"]);

export const listingCondition = pgEnum("listing_condition", [
  "new",
  "refurbished_manufacturer",
  "refurbished_seller",
  "factory_second",
  "display_model",
  "open_box",
  "used",
  "unknown",
]);

// How a listing was linked to its variant. See docs/DATA_MODEL.md, Matching.
export const matchMethod = pgEnum("match_method", ["manual", "gtin", "mpn", "title", "llm"]);

export const observationSource = pgEnum("observation_source", ["manual", "scrape", "api"]);

export const dealStatus = pgEnum("deal_status", ["draft", "published", "expired", "retracted"]);

// ---------- Shared column helpers ----------

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
// Set by the set_updated_at trigger, so edits made from Studio or psql are covered too.
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

// ---------- Tables ----------

// One row per shop.
export const retailer = pgTable(
  "retailer",
  {
    id: id(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    domain: text("domain").notNull().unique(),
    platform: text("platform"), // shopify, magento, custom. Hint for a scraper strategy later.
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [check("retailer_slug_format", sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`)],
);

// A product family: Samsung S90H OLED, 2026. Never carries a price.
export const product = pgTable(
  "product",
  {
    id: id(),
    slug: text("slug").notNull().unique(), // public URL segment: /p/{slug}
    brand: text("brand").notNull(),
    series: text("series").notNull(),
    category: text("category").notNull(), // tv, laptop, ... one category in v1
    releaseYear: integer("release_year"),
    displayName: text("display_name").notNull(),
    imageUrl: text("image_url"), // family hero image
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // NULLS NOT DISTINCT: two rows with a null year are still duplicates.
    unique("product_brand_series_year_uq").on(t.brand, t.series, t.releaseYear).nullsNotDistinct(),
    check("product_slug_format", sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
  ],
);

// One physical SKU: the 65-inch AU S90H. Price history hangs off this, never off product.
export const variant = pgTable(
  "variant",
  {
    id: id(),
    productId: uuid("product_id")
      .notNull()
      .references(() => product.id, { onDelete: "restrict" }),
    slug: text("slug").notNull(), // unique within the product: /p/{product}/{slug}
    displayName: text("display_name").notNull(),
    size: text("size"), // "65" for TVs, "14" for laptops; text so units stay flexible
    colour: text("colour"),
    region: text("region").notNull(), // ISO 3166-1 alpha-2. AU and US are different variants.
    rrpCents: integer("rrp_cents"), // manufacturer RRP at launch, when known
    attributes: jsonb("attributes").notNull().default({}), // category-specific: panel type, RAM, storage
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("variant_product_slug_uq").on(t.productId, t.slug),
    check("variant_slug_format", sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    check("variant_region_iso3166", sql`${t.region} ~ '^[A-Z]{2}$'`),
    check("variant_rrp_non_negative", sql`${t.rrpCents} IS NULL OR ${t.rrpCents} >= 0`),
  ],
);

// External identifiers for a variant. A variant carries one GTIN, one MPN and
// any number of retailer SKUs.
export const identifier = pgTable(
  "identifier",
  {
    id: id(),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => variant.id, { onDelete: "cascade" }),
    type: identifierType("type").notNull(),
    value: text("value").notNull(), // GTINs are stored as 14 digits; see lib/gtin
    retailerId: uuid("retailer_id").references(() => retailer.id, { onDelete: "cascade" }), // retailer_sku only
    createdAt: createdAt(),
  },
  (t) => [
    // NULLS NOT DISTINCT is what makes this hold for GTIN and MPN rows, where
    // retailer_id is null. Without it Postgres treats every null as distinct.
    unique("identifier_type_value_retailer_uq").on(t.type, t.value, t.retailerId).nullsNotDistinct(),
    index("identifier_variant_idx").on(t.variantId),
    check(
      "identifier_retailer_only_for_sku",
      sql`(${t.type} = 'retailer_sku') = (${t.retailerId} IS NOT NULL)`,
    ),
    check("identifier_gtin_is_14_digits", sql`${t.type} <> 'gtin' OR ${t.value} ~ '^[0-9]{14}$'`),
  ],
);

// One retailer page for one variant. A row here means the match is confirmed;
// unmatched pages will live in a staging table (phase 4), never here.
export const listing = pgTable(
  "listing",
  {
    id: id(),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => variant.id, { onDelete: "restrict" }),
    retailerId: uuid("retailer_id")
      .notNull()
      .references(() => retailer.id, { onDelete: "restrict" }),
    canonicalUrl: text("canonical_url").notNull(), // tracking params stripped; see lib/url
    retailerSku: text("retailer_sku"), // as printed on the page; the confirmed mapping is in identifier
    retailerTitle: text("retailer_title"),
    condition: listingCondition("condition").notNull().default("unknown"),
    conditionConfidence: real("condition_confidence").notNull().default(0),
    conditionNotes: text("condition_notes"),
    warrantyMonths: integer("warranty_months"),
    // How this page was linked to its variant (ADR-0010). Manual in v1.
    matchMethod: matchMethod("match_method").notNull(),
    matchConfidence: real("match_confidence").notNull().default(1),
    matchedAt: timestamp("matched_at", { withTimezone: true }).notNull().defaultNow(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("listing_retailer_url_uq").on(t.retailerId, t.canonicalUrl),
    index("listing_variant_idx").on(t.variantId),
    check("listing_condition_confidence_range", sql`${t.conditionConfidence} BETWEEN 0 AND 1`),
    check("listing_match_confidence_range", sql`${t.matchConfidence} BETWEEN 0 AND 1`),
  ],
);

// One price seen on one listing at one time. Append-only: a trigger rejects
// UPDATE and DELETE (ADR-0007). A bad row is corrected by inserting a new row
// that supersedes it (ADR-0009).
export const priceObservation = pgTable(
  "price_observation",
  {
    id: id(),
    listingId: uuid("listing_id")
      .notNull()
      .references(() => listing.id, { onDelete: "restrict" }),
    priceCents: integer("price_cents").notNull(),
    currency: text("currency").notNull().default("AUD"), // ISO 4217
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    source: observationSource("source").notNull(),
    confidence: real("confidence").notNull().default(1), // how sure the parser was; not a ranking device
    supersedesId: uuid("supersedes_id").references((): AnyPgColumn => priceObservation.id, {
      onDelete: "restrict",
    }),
    raw: jsonb("raw"), // whatever the scraper saw, so bad parses can be replayed
    createdAt: createdAt(),
  },
  (t) => [
    index("price_observation_listing_time_idx").on(t.listingId, t.observedAt.desc()),
    index("price_observation_supersedes_idx")
      .on(t.supersedesId)
      .where(sql`${t.supersedesId} IS NOT NULL`),
    check("price_observation_price_non_negative", sql`${t.priceCents} >= 0`),
    check("price_observation_confidence_range", sql`${t.confidence} BETWEEN 0 AND 1`),
    check("price_observation_currency_iso4217", sql`${t.currency} ~ '^[A-Z]{3}$'`),
  ],
);

// An editorial call: this observation is worth telling people about (ADR-0006).
// Reaches its listing, variant and product through the observation.
export const deal = pgTable(
  "deal",
  {
    id: id(),
    priceObservationId: uuid("price_observation_id")
      .notNull()
      .references(() => priceObservation.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    commentary: text("commentary"),
    status: dealStatus("status").notNull().default("draft"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdBy: text("created_by").notNull(), // auth user id from phase 2; free text until then
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("deal_status_published_idx").on(t.status, t.publishedAt.desc()),
    index("deal_observation_idx").on(t.priceObservationId),
    check(
      "deal_published_has_timestamp",
      sql`${t.status} <> 'published' OR ${t.publishedAt} IS NOT NULL`,
    ),
  ],
);
