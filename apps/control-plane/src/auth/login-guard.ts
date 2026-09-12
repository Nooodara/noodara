import { APIError, isAPIError, type createAuthMiddleware } from 'better-auth/api';
import { sql } from 'drizzle-orm';
import { evaluateFailure, isLockedOut, type LoginBackoffConfig } from '@noodara/domain/security';
import { writeActivityEvent } from '../activity/write-activity-event.js';
import { getDb } from '../db/client.js';
import { users } from '../db/schema/auth.js';
import { env } from '../env.js';
import {
  clearAttempts,
  loadAttempt,
  recordFailure,
  type LoginAttemptScope,
} from '../services/login-attempt-repository.js';

// D-07 / RESEARCH Pitfall 2: Better Auth's own `rateLimit` stays enabled (see auth.ts's
// `advanced` comment) purely as a coarse, path-level secondary defense — it is IP+path keyed
// only, so it cannot independently track failures per account and has no progressive backoff.
// This module is the real AUTH-04 mechanism: a Postgres-backed counter, scoped independently by
// IP and by account, that rejects a locked-out request before Better Auth's sign-in handler ever
// runs (`loginGuard`), and records the real outcome once it does (`loginGuardAfter`).
type AuthHookContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

const SIGN_IN_EMAIL_PATH = '/sign-in/email';

// Set by routes/auth.ts from Fastify's own `request.ip` (which already applies the
// `NOODARA_TRUST_PROXY`-gated policy, app.ts) — never read directly from `X-Forwarded-For` here,
// so this module never has to re-implement proxy-trust logic itself (T-1-40).
const CLIENT_IP_HEADER = 'x-noodara-client-ip';
const UNKNOWN_IP_KEY = 'unknown';

// `activity_events.entity_id` is a `uuid` column (Plan 01-07) — a submitted email that does not
// belong to any real user (a wrong-email guess, not just a wrong password) has no UUID to record.
// This nil UUID is never a real row's id (UUIDv7 primary keys always carry a non-zero version
// nibble), so it unambiguously means "no matching account" without weakening the column's type.
const UNKNOWN_USER_ENTITY_ID = '00000000-0000-0000-0000-000000000000';

/** Best-effort lookup of the real user id for `email`, so a failed/blocked login against a known
 *  account is recorded against that account's real id — never the email itself, which is not a
 *  valid `uuid`. Falls back to `UNKNOWN_USER_ENTITY_ID` for an email matching no user at all. */
async function resolveUserEntityId(db: Awaited<ReturnType<typeof getDb>>, email: string): Promise<string> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);
  return row?.id ?? UNKNOWN_USER_ENTITY_ID;
}

function backoffConfig(): LoginBackoffConfig {
  return {
    maxAttempts: env.NOODARA_LOGIN_MAX_ATTEMPTS,
    windowSeconds: env.NOODARA_LOGIN_WINDOW_SECONDS,
    maxBackoffSeconds: env.NOODARA_LOGIN_BACKOFF_MAX_SECONDS,
  };
}

function isSignInEmail(ctx: AuthHookContext): boolean {
  return ctx.path === SIGN_IN_EMAIL_PATH;
}

function resolveIpKey(ctx: AuthHookContext): string {
  const ip = ctx.request?.headers.get(CLIENT_IP_HEADER);
  return ip !== null && ip !== undefined && ip.length > 0 ? ip : UNKNOWN_IP_KEY;
}

/** The account scope key is the lowercased submitted email — never the password, never a user id
 *  we have not yet resolved (a wrong email must count against *some* account-scoped key just as
 *  much as a wrong password against a real one, or the per-account scope could be bypassed by
 *  varying the email). Returns `undefined` for a malformed body, in which case this guard steps
 *  aside and lets Better Auth's own body validation reject the request. */
function resolveAccountKey(ctx: AuthHookContext): string | undefined {
  const body = ctx.body as { email?: unknown } | undefined;
  const email = typeof body?.email === 'string' ? body.email : undefined;
  return email !== undefined && email.length > 0 ? email.toLowerCase() : undefined;
}

interface ScopedKeys {
  readonly ipKey: string;
  readonly accountKey: string;
}

function resolveScopedKeys(ctx: AuthHookContext): ScopedKeys | undefined {
  if (!isSignInEmail(ctx)) return undefined;
  const accountKey = resolveAccountKey(ctx);
  if (accountKey === undefined) return undefined;
  return { ipKey: resolveIpKey(ctx), accountKey };
}

/**
 * Runs before Better Auth's sign-in handler. If either the IP or the account scope is currently
 * locked out, throws a `TOO_MANY_REQUESTS` `APIError` carrying a `Retry-After` header — the
 * established better-auth idiom for a before-hook rejecting with a specific status code (see
 * `better-auth/api`'s own `originCheckMiddleware`), since a plain returned object from a
 * before-hook cannot carry a non-200 status through better-call's dispatch pipeline. Throwing
 * here is what keeps the submitted password from ever reaching `verifyPassword`: a before-hook
 * that throws short-circuits both the endpoint handler and `loginGuardAfter` entirely.
 */
export async function loginGuard(ctx: AuthHookContext): Promise<unknown> {
  const keys = resolveScopedKeys(ctx);
  if (!keys) return undefined;

  const { ipKey, accountKey } = keys;
  const now = new Date();
  const db = await getDb();

  const [ipState, accountState] = await Promise.all([
    loadAttempt(db, 'ip', ipKey, now),
    loadAttempt(db, 'account', accountKey, now),
  ]);
  const ipStatus = isLockedOut(ipState, now);
  const accountStatus = isLockedOut(accountState, now);

  if (!ipStatus.locked && !accountStatus.locked) return undefined;

  const retryAfterSeconds = Math.max(
    ipStatus.locked ? ipStatus.retryAfterSeconds : 0,
    accountStatus.locked ? accountStatus.retryAfterSeconds : 0,
  );

  await writeActivityEvent(
    db,
    {
      actorType: 'system',
      entityType: 'user',
      entityId: await resolveUserEntityId(db, accountKey),
      action: 'auth.login_blocked',
      outcome: 'failure',
      metadata: { email: accountKey, ip: ipKey },
    },
    now,
  );

  throw new APIError(
    'TOO_MANY_REQUESTS',
    { message: 'Too many login attempts. Try again later.', code: 'LOGIN_LOCKED' },
    { 'retry-after': String(retryAfterSeconds) },
  );
}

async function applyFailure(
  db: Awaited<ReturnType<typeof getDb>>,
  scope: LoginAttemptScope,
  key: string,
  now: Date,
  config: LoginBackoffConfig,
): Promise<void> {
  const state = await loadAttempt(db, scope, key, now);
  const next = evaluateFailure(state, now, config);
  await recordFailure(db, scope, key, next, now);
}

/**
 * Runs after Better Auth's sign-in handler — never called at all when `loginGuard` blocked the
 * request (a thrown `APIError` from the before-hook short-circuits the whole dispatch, including
 * `hooks.after`, per better-call's own dispatch pipeline). On a genuine authentication failure
 * (`ctx.context.returned` is an `APIError`, e.g. wrong password), applies the progressive-backoff
 * math to both scopes and records `auth.login_failed`. On success, clears both scopes'
 * history — a legitimate admin is never progressively penalised — and records
 * `auth.login_succeeded`.
 */
export async function loginGuardAfter(ctx: AuthHookContext): Promise<unknown> {
  const keys = resolveScopedKeys(ctx);
  if (!keys) return undefined;

  const { ipKey, accountKey } = keys;
  const now = new Date();
  const config = backoffConfig();
  const db = await getDb();
  const returned: unknown = ctx.context.returned;

  if (isAPIError(returned)) {
    await Promise.all([
      applyFailure(db, 'ip', ipKey, now, config),
      applyFailure(db, 'account', accountKey, now, config),
    ]);
    await writeActivityEvent(
      db,
      {
        actorType: 'system',
        entityType: 'user',
        entityId: await resolveUserEntityId(db, accountKey),
        action: 'auth.login_failed',
        outcome: 'failure',
        metadata: { email: accountKey, ip: ipKey },
      },
      now,
    );
    return undefined;
  }

  // D-07: a successful login fully forgives history for both scopes. Deleting the rows (rather
  // than loading each one just to apply `clearOnSuccess` and write the zeroed state back)
  // achieves the identical outcome — `loadAttempt`'s own "no row = fresh counter" contract means
  // an absent row is indistinguishable from one that was just cleared.
  await clearAttempts(db, [
    { scope: 'ip', key: ipKey },
    { scope: 'account', key: accountKey },
  ]);

  const newSession = ctx.context.newSession;
  await writeActivityEvent(
    db,
    {
      actorType: 'user',
      actorId: newSession?.user.id ?? null,
      entityType: 'user',
      entityId: newSession?.user.id ?? accountKey,
      action: 'auth.login_succeeded',
      outcome: 'success',
      metadata: { email: accountKey, ip: ipKey },
    },
    now,
  );
  return undefined;
}
