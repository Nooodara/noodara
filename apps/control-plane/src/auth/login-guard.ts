import type { createAuthMiddleware } from 'better-auth/api';

// Owned by Plan 01-13 (AUTH-04: per-IP and per-account progressive-backoff lockout — Better
// Auth's own `rateLimit` is IP+path keyed only, RESEARCH Pitfall 2). Inert here — two functions
// because a lockout must be checked *before* the sign-in handler runs (`loginGuard`) and the
// outcome can only be recorded *after* it (`loginGuardAfter`, e.g. incrementing the failure
// counter or writing the activity-log entry). Both always let the request through; a truthy
// return from `loginGuard` short-circuits the request (see hooks.ts).
type AuthHookContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

export function loginGuard(_ctx: AuthHookContext): Promise<unknown> {
  return Promise.resolve(undefined);
}

export function loginGuardAfter(_ctx: AuthHookContext): Promise<unknown> {
  return Promise.resolve(undefined);
}
