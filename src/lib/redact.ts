// Removes secrets from text before a person sees it. Pure: the caller says
// which values are secret.

export const REDACTED = "REDACTED";

/** Shorter than this, a value is too likely to match ordinary text to be worth replacing. */
const MIN_SECRET_LENGTH = 4;

/**
 * `text` with every occurrence of every secret replaced by "REDACTED".
 * Undefined, blank and very short values are ignored. Longer secrets go
 * first, so a secret that contains another is removed whole.
 */
export function redactSecrets(text: string, secrets: readonly (string | undefined)[]): string {
  const values = secrets
    .filter((secret): secret is string => secret !== undefined)
    .map((secret) => secret.trim())
    .filter((secret) => secret.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);
  let redacted = text;
  for (const value of values) redacted = redacted.split(value).join(REDACTED);
  return redacted;
}
