// T-4-02/T-5-02: one shared bounded-race wrapper for every `getSession` call site
// (`require-session.ts`'s request guard and `routes/events.ts`'s SSE heartbeat) — a hung
// session lookup resolves as a failure within `SESSION_LOOKUP_TIMEOUT_MS` instead of holding a
// request open or keeping a revoked session's stream alive. Mirrors `routes/health.ts`'s own
// proven `withTimeout` `Promise.race` shape (that file's own `CHECK_TIMEOUT_MS` local-constant
// precedent). Deliberately imports nothing from `env.ts`: the bound is a module constant so both
// call sites and this file's own tests stay env-free.
export const SESSION_LOOKUP_TIMEOUT_MS = 2000;

/** T-5-03: the rejection message is a fixed literal — never interpolate headers, cookies, a
 *  user id or any other request-derived value into it. A rejection from `fn()` itself propagates
 *  unchanged; this wrapper adds no retry and swallows nothing. */
export function withSessionLookupTimeout<T>(fn: () => Promise<T>, ms: number = SESSION_LOOKUP_TIMEOUT_MS): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => {
        reject(new Error('session lookup timed out'));
      }, ms);
    }),
  ]);
}
