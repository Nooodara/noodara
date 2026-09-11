import { createAuthMiddleware } from 'better-auth/api';
import { loginGuard, loginGuardAfter } from './login-guard.js';
import { signupGate } from './signup-gate.js';

// The single before/after hook composition point (this plan's own objective): every later auth
// plan (01-11 session-policy, 01-12 signup-gate, 01-13 login-guard) extends behavior through its
// own owned module, never by editing this file or auth.ts. `composedBefore` short-circuits on the
// first extension point that returns a value; `composedAfter` always runs `loginGuardAfter` since
// recording an outcome is not itself a decision to block anything.
export const composedBefore = createAuthMiddleware(async (ctx) => {
  const signupResult = await signupGate(ctx);
  if (signupResult !== undefined) return signupResult;

  const loginResult = await loginGuard(ctx);
  if (loginResult !== undefined) return loginResult;

  return undefined;
});

export const composedAfter = createAuthMiddleware(async (ctx) => {
  await loginGuardAfter(ctx);
});
