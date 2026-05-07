/**
 * Typed errors thrown from inside services to signal a domain-level outcome.
 * Routes catch them and map to HTTP status codes via `handleServiceError`.
 *
 * Owning these here (instead of inside any one service module) keeps the
 * error vocabulary the same across services that share a router-side mapping.
 */

export class NotFoundError extends Error {
  readonly code = 'NOT_FOUND' as const;
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends Error {
  readonly code = 'CONFLICT' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

export class PreconditionError extends Error {
  readonly code = 'PRECONDITION' as const;
  constructor(message: string) {
    super(message);
    this.name = 'PreconditionError';
  }
}

export class ForbiddenError extends Error {
  readonly code = 'FORBIDDEN' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/** True for Postgres unique-constraint / duplicate-key error messages. Walks
 *  the cause chain because Drizzle wraps driver errors in `DrizzleQueryError`,
 *  which doesn't surface the constraint violation in its top-level message. */
export function isUniqueError(err: unknown): boolean {
  let current: unknown = err;
  while (current instanceof Error) {
    const msg = current.message;
    if (msg.includes('unique') || msg.includes('duplicate')) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Maps a domain error to an HTTP response. Returns null if `err` is not a
 * recognised domain error — caller should rethrow in that case so framework
 * error handling can take over.
 */
export function handleServiceError(
  err: unknown,
  c: { json: (body: unknown, status: number) => Response },
): Response | null {
  if (err instanceof Error) {
    const code = (err as { code?: string }).code;
    if (code === 'NOT_FOUND') return c.json({ error: err.message }, 404) as Response;
    if (code === 'CONFLICT') return c.json({ error: err.message }, 409) as Response;
    if (code === 'PRECONDITION') return c.json({ error: err.message }, 400) as Response;
    if (code === 'FORBIDDEN') return c.json({ error: err.message }, 403) as Response;
  }
  return null;
}
