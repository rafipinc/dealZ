// Brand names as one row each. A store's `vendor` arrives as "SAMSUNG" from
// one store and "Samsung" from another, and the catalogue's product family
// must be one row per brand, so "Add to catalogue" (issue #10) normalises
// the brand before it writes. A small table holds the canonical casing of
// the brands DealZ expects; any other brand is title-cased one word at a
// time, so "MOZA RACING" becomes "Moza Racing". Spelling variants, "DeLonghi"
// for "De'Longhi" or "Fisher and Paykel", are not folded: add a row here
// when a store prints one.
//
// Not wired into any service yet.

/** The brands DealZ expects, in the casing the brand itself uses. */
const CANONICAL_BRANDS: readonly string[] = [
  "Samsung",
  "LG",
  "Sony",
  "TCL",
  "Hisense",
  "Panasonic",
  "Philips",
  "Sharp",
  "Apple",
  "Microsoft",
  "Nintendo",
  "Dyson",
  "Bose",
  "JBL",
  "Sonos",
  "Sennheiser",
  "Breville",
  "De'Longhi",
  "Fisher & Paykel",
  "Bosch",
  "Miele",
  "Electrolux",
  "Westinghouse",
  "Beko",
  "Haier",
  "CHiQ",
  "Google",
  "Lenovo",
  "HP",
  "Dell",
  "ASUS",
  "Acer",
  "Logitech",
  "Razer",
  "GoPro",
  "Canon",
  "Nikon",
  "Fujifilm",
  "Garmin",
  "Fitbit",
  "Xbox",
  "PlayStation",
];

const BY_LOWER_CASE: ReadonlyMap<string, string> = new Map(
  CANONICAL_BRANDS.map((brand) => [brand.toLowerCase(), brand]),
);

/** First letter upper, the rest lower. */
function titleCaseWord(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * The brand in its canonical casing when the table knows it, else
 * title-cased word by word. Whitespace is trimmed and collapsed first. An
 * empty or blank string comes back empty.
 */
export function normaliseBrand(input: string): string {
  const collapsed = input.trim().replace(/\s+/g, " ");
  if (collapsed === "") return "";
  return (
    BY_LOWER_CASE.get(collapsed.toLowerCase()) ?? collapsed.split(" ").map(titleCaseWord).join(" ")
  );
}
