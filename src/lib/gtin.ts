// GTIN normalisation. A GTIN enters in any form (8, 12, 13 or 14 digits,
// with optional whitespace or hyphens) and leaves as 14 digits with a valid
// GS1 mod-10 check digit, or as null.

const ACCEPTED_LENGTHS: ReadonlySet<number> = new Set([8, 12, 13, 14]);

/** GS1 check digit for the first 13 digits of a 14-digit GTIN. */
function checkDigit(first13: string): number {
  let sum = 0;
  for (let i = 0; i < first13.length; i += 1) {
    const weight = i % 2 === 0 ? 3 : 1;
    sum += Number(first13.charAt(i)) * weight;
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * Returns the 14-digit form of a GTIN, or null when the input is not a
 * well-formed GTIN-8, GTIN-12, GTIN-13 or GTIN-14 with a valid check digit.
 */
export function normaliseGtin(input: string): string | null {
  const digits = input.replace(/[\s-]/g, "");
  if (!/^[0-9]+$/.test(digits)) return null;
  if (!ACCEPTED_LENGTHS.has(digits.length)) return null;
  const padded = digits.padStart(14, "0");
  const expected = checkDigit(padded.slice(0, 13));
  return Number(padded.charAt(13)) === expected ? padded : null;
}

export function isValidGtin(input: string): boolean {
  return normaliseGtin(input) !== null;
}
