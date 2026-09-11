import type { createAuthMiddleware } from 'better-auth/api';

// Owned by Plan 01-12 (AUTH-01: the first admin comes only from the setup token; `/sign-up/email`
// must 404 once an admin exists). Inert here — always lets the request through — so this plan's
// `composedBefore` (hooks.ts) has a stable extension point Plan 01-12 fills in without touching
// hooks.ts or auth.ts. A truthy return value short-circuits the request (see `ctx.json(...)` in
// Better Auth's hooks docs); `undefined` means "continue".
type AuthHookContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

export function signupGate(_ctx: AuthHookContext): Promise<unknown> {
  return Promise.resolve(undefined);
}
