// Typed errors services throw. Adapters map `code` to an HTTP status or UI
// state (ARCHITECTURE.md section 6); nothing else catches them.

export class NotFoundError extends Error {
  readonly code = "not_found" as const;

  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  readonly code = "conflict" as const;

  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export class ValidationError extends Error {
  readonly code = "validation" as const;
  /** The Zod issues, when the failure came from a schema parse. */
  readonly issues: unknown;

  constructor(message: string, issues?: unknown) {
    super(message);
    this.name = "ValidationError";
    this.issues = issues;
  }
}
