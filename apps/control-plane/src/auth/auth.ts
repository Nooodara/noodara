import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { uuidv7 } from 'uuidv7';
import { createDb } from '../db/client.js';
import * as schema from '../db/schema/index.js';
import { env } from '../env.js';
import * as authHooks from './hooks.js';
import { hashPassword, verifyPassword } from './password-hasher.js';
import { sessionPolicy } from './session-policy.js';

// This project's Drizzle tables are plural (`users`, `sessions`, `accounts`, `verifications`)
// while Better Auth's adapter looks up its four core models by their singular names. `usePlural`
// only affects relation/db.query lookups, not this primary lookup, so the schema object handed
// to `drizzleAdapter` must remap the singular keys explicitly (confirmed against the installed
// `@better-auth/drizzle-adapter` source — its own docs' "usePlural" example does not cover this).
const authSchema = {
  ...schema,
  user: schema.users,
  session: schema.sessions,
  account: schema.accounts,
  verification: schema.verifications,
};

const { db } = createDb(env.DATABASE_URL);

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg', schema: authSchema }),
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.NOODARA_PUBLIC_URL,
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 12,
    maxPasswordLength: 128,
    password: {
      hash: hashPassword,
      verify: verifyPassword,
    },
  },
  advanced: {
    database: {
      // PostgreSQL 16/17 has no native uuidv7() (RESEARCH Summary) — generated application-side.
      generateId: () => uuidv7(),
      // Better Auth's startup schema check compares `accounts` against its *full* default shape,
      // including OAuth-only columns (accessToken, refreshToken, idToken, ...) this project never
      // uses — v0.1 supports only the single local admin's email/password (CLAUDE.md scope, no
      // social providers). Without this, every request throws `SchemaMismatchError` before
      // Better Auth's handler ever runs.
      validateSchema: false,
    },
    // D-08: Secure is derived only from the explicit opt-out flag, never from the runtime mode —
    // Better Auth's own default falls back to a "running in production" heuristic when this is
    // left unset, which would silently drop Secure on any deployment with a misconfigured runtime
    // mode. The flag's warning-log side effect lives in routes/auth.ts.
    useSecureCookies: !env.NOODARA_COOKIE_INSECURE,
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
    },
    // D-07 / RESEARCH Pitfall 2: Better Auth's native rateLimit is IP+path keyed only — it is
    // kept at its default (enabled) purely as a coarse secondary defense, never as AUTH-04's
    // mechanism. The account-aware, progressively-backed-off guard is Plan 01-13's login-guard.ts.
  },
  session: sessionPolicy.config,
  databaseHooks: sessionPolicy.hooks,
  hooks: {
    before: authHooks.composedBefore,
    after: authHooks.composedAfter,
  },
});
