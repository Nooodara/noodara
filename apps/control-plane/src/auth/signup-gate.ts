import type { createAuthMiddleware } from 'better-auth/api';
import { isBootstrapInProgress } from './bootstrap-context.js';

// AUTH-01/D-02: the only way `/sign-up/email` may ever create a user is through
// `setup-service.ts`'s own internal call inside `runInBootstrap` — every other request to this
// path, before or after an admin exists, gets a 404. 404 rather than 403 so the endpoint's very
// existence is never confirmed to an unauthenticated caller (T-1-36), matching D-02's stance for
// the `/api/setup` route itself. `composedBefore` (hooks.ts) short-circuits on this truthy return.
type AuthHookContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

const SIGN_UP_EMAIL_PATH = '/sign-up/email';

export function signupGate(ctx: AuthHookContext): Promise<unknown> {
  if (ctx.path !== SIGN_UP_EMAIL_PATH || isBootstrapInProgress()) {
    return Promise.resolve(undefined);
  }
  return Promise.resolve(ctx.json(null, { status: 404 }));
}
