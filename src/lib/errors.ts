// What a failure is really about. Pure: no I/O, nothing internal.

/**
 * The innermost reason behind a failure. The query layer wraps a driver
 * error in one whose message is the SQL that failed; the innermost Error in
 * the cause chain says why (connection refused, a table missing), which is
 * what a person needs. When that Error's own cause is a non-blank string
 * ("ECONNRESET"), the string is the reason and is returned instead. A cause
 * chain that loops back on itself stops at the last Error not yet seen. A
 * failure that is not an Error is returned as it is.
 */
export function rootCause(error: unknown): unknown {
  let root = error;
  const seen = new Set<unknown>([root]);
  while (root instanceof Error && root.cause instanceof Error && !seen.has(root.cause)) {
    root = root.cause;
    seen.add(root);
  }
  if (root instanceof Error && typeof root.cause === "string" && root.cause.trim() !== "") {
    return root.cause;
  }
  return root;
}
