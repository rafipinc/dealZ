// Money is integer cents everywhere in DealZ. These helpers convert at the
// edges: retailer strings in, display strings out.

/**
 * Parses a price as integer cents. Accepts a number or a string with
 * currency symbols, letters, commas and whitespace around the digits.
 * Returns null for empty, non-numeric, non-finite or negative input.
 */
export function parseCents(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  let value: number;
  if (typeof input === "number") {
    value = input;
  } else {
    const cleaned = input.replace(/[^0-9.-]/g, "");
    if (!/[0-9]/.test(cleaned)) return null;
    value = Number(cleaned);
  }
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

/** Formats integer cents as Australian dollars: "$2,795.00", "-$1.00". */
export function formatAud(cents: number): string {
  const rounded = Math.round(cents);
  const sign = rounded < 0 ? "-" : "";
  const magnitude = Math.abs(rounded);
  const dollars = Math.floor(magnitude / 100);
  const remainder = magnitude % 100;
  const grouped = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}$${grouped}.${String(remainder).padStart(2, "0")}`;
}

/** "+$400.00" for a positive delta; formatAud already prints the minus sign. */
export function formatSignedAud(cents: number): string {
  return cents > 0 ? `+${formatAud(cents)}` : formatAud(cents);
}

/** "cheapest" for a zero delta, otherwise the signed amount. */
export function formatVsCheapest(deltaCents: number): string {
  return deltaCents === 0 ? "cheapest" : formatSignedAud(deltaCents);
}

/** "-$500.00 (15% under RRP)", "+$100.00 (3% over RRP)" or "$0.00 (at RRP)". */
export function formatVsRrp(deltaCents: number, rrpCents: number): string {
  const amount = formatSignedAud(deltaCents);
  if (deltaCents === 0 || rrpCents <= 0) return `${amount} (at RRP)`;
  const percent = Math.round((Math.abs(deltaCents) / rrpCents) * 100);
  const direction = deltaCents < 0 ? "under" : "over";
  return `${amount} (${percent}% ${direction} RRP)`;
}
