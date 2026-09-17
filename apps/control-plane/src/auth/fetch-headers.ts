// Relocated verbatim from `services/session-service.ts` (D-17): this file must import nothing
// from the Better Auth binding module, the database client module, or the env-validation module
// — that zero-dependency property is what lets `require-session.test.ts` run as a real unit test
// with no database connection.

/** Fastify's `request.headers` (an `IncomingHttpHeaders`-shaped object) into a fetch-standard
 *  `Headers` instance — the only shape `auth.api.*` accepts (`better-call`'s `requireHeaders`). */
export function toFetchHeaders(headers: Record<string, string | string[] | undefined>): Headers {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) result.append(key, entry);
    } else {
      result.set(key, value);
    }
  }
  return result;
}
