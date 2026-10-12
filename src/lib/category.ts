// DealZ's own categories, and a mapper from what a store says to one of
// them. A store's label stays in `store_type` as printed ("4K QLED UHD",
// "VISUAL", "GAMES HARDWARE"); the slug here is DealZ's, one list for every
// store. The database enforces only the slug's shape (kebab-case), never
// its membership, so a category is added here without a migration.
//
// categoryOf reads, in order: a hint that is a known slug (a seeded
// collection's category, decided when the collection was seeded); the
// store's type, matched whole and case-insensitively against a small map;
// a store tag of the same kind; then the title, most specific rule first
// and the broad TV rule last, so "Soundbar for your OLED TV" is a soundbar.
// JB Hi-Fi's "VISUAL" and "GAMES HARDWARE" map to nothing: each spans
// several categories (TVs and DVD players; consoles and racing wheels), so
// the title decides. Shopify tags such as "Brand:Lg" are ignored.
//
// Known false positives, kept for simplicity: a title that names its
// product's category without being one. "Powerwave RGB Lighting Stand for
// Xbox Series X" is nothing, as it lacks "console", but a "TV wall mount"
// is a TV, and "Nintendo Switch OLED Model" without "console" is a TV by
// the "oled" rule.

export const CATEGORIES = [
  { slug: "tv", name: "TVs" },
  { slug: "soundbar", name: "Soundbars" },
  { slug: "speaker", name: "Speakers" },
  { slug: "headphones", name: "Headphones" },
  { slug: "console", name: "Game consoles" },
  { slug: "laptop", name: "Laptops" },
  { slug: "desktop", name: "Desktops" },
  { slug: "monitor", name: "Monitors" },
  { slug: "phone", name: "Phones" },
  { slug: "tablet", name: "Tablets" },
  { slug: "camera", name: "Cameras" },
  { slug: "vacuum", name: "Vacuums" },
  { slug: "coffee-machine", name: "Coffee machines" },
  { slug: "air-conditioner", name: "Air conditioners" },
] as const satisfies readonly { slug: string; name: string }[];

export type CategorySlug = (typeof CATEGORIES)[number]["slug"];

const SLUGS: ReadonlySet<string> = new Set(CATEGORIES.map((category) => category.slug));

export function isCategorySlug(value: string): value is CategorySlug {
  return SLUGS.has(value);
}

/**
 * A store's product type, lower-cased, to a category. Whole labels only; a
 * label that spans categories ("VISUAL", "AUDIO", "IT") is absent.
 */
const STORE_TYPES: ReadonlyMap<string, CategorySlug> = new Map<string, CategorySlug>([
  ["tv", "tv"],
  ["tvs", "tv"],
  ["television", "tv"],
  ["televisions", "tv"],
  ["smart tv", "tv"],
  ["led tv", "tv"],
  ["oled", "tv"],
  ["qled", "tv"],
  ["qned", "tv"],
  // Powerland's labels, seen in the fixtures of 2026-10-06.
  ["4k qned tv", "tv"],
  ["4k qled uhd", "tv"],
  ["4k ultra hd led", "tv"],
  ["soundbar", "soundbar"],
  ["soundbars", "soundbar"],
  ["sound bar", "soundbar"],
  ["sound bars", "soundbar"],
  ["speaker", "speaker"],
  ["speakers", "speaker"],
  ["headphones", "headphones"],
  ["earbuds", "headphones"],
  ["console", "console"],
  ["consoles", "console"],
  ["game console", "console"],
  ["laptop", "laptop"],
  ["laptops", "laptop"],
  ["notebook", "laptop"],
  ["notebooks", "laptop"],
  ["desktop", "desktop"],
  ["desktops", "desktop"],
  ["monitor", "monitor"],
  ["monitors", "monitor"],
  ["phone", "phone"],
  ["phones", "phone"],
  ["mobile phone", "phone"],
  ["mobile phones", "phone"],
  ["smartphone", "phone"],
  ["tablet", "tablet"],
  ["tablets", "tablet"],
  ["camera", "camera"],
  ["cameras", "camera"],
  ["vacuum", "vacuum"],
  ["vacuums", "vacuum"],
  ["stick vacuum", "vacuum"],
  ["stick vacuums", "vacuum"],
  ["robot vacuum", "vacuum"],
  ["vacuum cleaner", "vacuum"],
  ["vacuum cleaners", "vacuum"],
  ["coffee machine", "coffee-machine"],
  ["coffee machines", "coffee-machine"],
  ["espresso machine", "coffee-machine"],
  ["air conditioner", "air-conditioner"],
  ["air conditioners", "air-conditioner"],
  ["split system", "air-conditioner"],
]);

/** The few store tags that name a category outright. Powerland tags its TVs "televisions". */
const TAGS: ReadonlyMap<string, CategorySlug> = new Map<string, CategorySlug>([
  ["televisions", "tv"],
]);

/** A category the title names when every pattern matches the lower-cased title. */
interface TitleRule {
  slug: CategorySlug;
  every: readonly RegExp[];
}

/** Most specific first; the TV rule is last because "tv" appears in many titles. */
const TITLE_RULES: readonly TitleRule[] = [
  { slug: "soundbar", every: [/\bsound ?bar\b/] },
  { slug: "headphones", every: [/\b(?:headphones?|earbuds?|earphones?)\b/] },
  { slug: "console", every: [/\b(?:xbox|playstation|nintendo switch)\b/, /\bconsole\b/] },
  { slug: "laptop", every: [/\b(?:laptop|macbook|notebook|chromebook)\b/] },
  { slug: "monitor", every: [/\bmonitor\b/] },
  { slug: "phone", every: [/\biphone\b|\bgalaxy s\d|\bpixel \d/] },
  { slug: "tablet", every: [/\b(?:ipad|tablet)\b/] },
  { slug: "vacuum", every: [/\bvacuum\b|\bstick vac\b/] },
  { slug: "coffee-machine", every: [/\bcoffee machine\b|\bespresso\b/] },
  { slug: "air-conditioner", every: [/\bair ?conditioner\b|\bsplit system\b/] },
  { slug: "tv", every: [/\b(?:oled|qled|qned|tv)\b/] },
];

export interface CategoryInput {
  title: string;
  /** The store's own label, as it stays in `store_type`. */
  storeType: string | null;
  /** The store's tags, Shopify style. Only the few in TAGS are read. */
  tags?: readonly string[];
  /** A slug decided ahead of the product, such as a seeded collection's category. */
  hint?: string | null;
}

function normaliseLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * The DealZ category of a store product, or null when nothing names one:
 * the hint, then the store type, then a tag, then the title, as the header
 * describes.
 */
export function categoryOf(input: CategoryInput): CategorySlug | null {
  const hint = input.hint ?? null;
  if (hint !== null && isCategorySlug(hint)) return hint;

  if (input.storeType !== null) {
    const byType = STORE_TYPES.get(normaliseLabel(input.storeType));
    if (byType !== undefined) return byType;
  }

  for (const tag of input.tags ?? []) {
    const byTag = TAGS.get(normaliseLabel(tag));
    if (byTag !== undefined) return byTag;
  }

  const title = input.title.toLowerCase();
  const byTitle = TITLE_RULES.find((rule) => rule.every.every((pattern) => pattern.test(title)));
  return byTitle?.slug ?? null;
}
