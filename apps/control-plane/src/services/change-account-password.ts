// SET-03 (D-05/D-06/D-07/D-08): `POST /api/account/password`'s service. Delegates the actual
// password change to Better Auth's own `changePassword` (through the injected `deps.changePassword`
// — the route's real wrapper calls `auth.api.changePassword` and immediately drops everything
// except the rotated session's `Set-Cookie` headers, per this file's `ChangePasswordDelegate`
// type below — Better Auth's own response body, `{ token, user }`, is never even received here).
// Enforces the v0.1 password policy server-side (`validatePassword`, unchanged from AUTH-02),
// throttles wrong current-password attempts through the same kind of `ReauthGuard`
// `update-account-profile.ts` uses (a distinct `reauth:<userId>` scope, T-09-01), and records
// exactly one `account.password_changed` activity event with the revoked-session count — never a
// token, a password or a hash (D-08).
import { and, eq, ne } from 'drizzle-orm';
import { isAPIError } from 'better-auth/api';
import { validatePassword } from '@noodara/domain/validators';
import { writeActivityEvent } from '../activity/write-activity-event.js';
import type { ReauthGuard } from '../auth/reauth-guard.js';
import { recordPasswordChangeRevocations } from '../auth/session-revocation-markers.js';
import type { Database } from '../db/client.js';
import { sessions, users } from '../db/schema/auth.js';
import type { ServiceActor } from './server-service-deps.js';

export type ChangeAccountPasswordFailureCode = 'INVALID_CREDENTIAL' | 'VALIDATION_FAILED' | 'REAUTH_LOCKED';

export interface ChangeAccountPasswordInput {
  readonly actor: ServiceActor;
  readonly sessionId: string;
  readonly headers: Headers;
  readonly currentPassword: string;
  readonly newPassword: string;
}

export type ChangeAccountPasswordResult =
  | {
      readonly ok: true;
      readonly value: { readonly sessionsRevoked: number; readonly setCookies: readonly string[] };
    }
  | {
      readonly ok: false;
      readonly code: ChangeAccountPasswordFailureCode;
      readonly message: string;
      readonly field?: string;
      readonly retryAfterSeconds?: number;
    };

/** The one shape this service ever receives back from Better Auth — `headers` only. A wrong
 *  `currentPassword` (or any other Better Auth failure) always rejects; this never resolves with
 *  a failure value of its own. */
export type ChangePasswordDelegate = (args: {
  body: { currentPassword: string; newPassword: string; revokeOtherSessions: true };
  headers: Headers;
  returnHeaders: true;
}) => Promise<{ headers: Headers }>;

export interface ChangeAccountPasswordDeps {
  readonly db: Database;
  readonly reauthGuard: ReauthGuard;
  readonly changePassword: ChangePasswordDelegate;
  readonly now: () => Date;
}

const WEAK_PASSWORD_MESSAGE = 'Password must be 12–128 characters and not be a commonly used password.';

/**
 * SET-03: changes the admin's password under the v0.1 policy, revoking every other session
 * (D-05) while keeping the caller's own session alive via its rotated cookie, and reporting the
 * revoked-session count (D-06) without ever exposing Better Auth's own session token.
 */
export async function changeAccountPassword(
  deps: ChangeAccountPasswordDeps,
  input: ChangeAccountPasswordInput,
): Promise<ChangeAccountPasswordResult> {
  const userId = input.actor.type === 'user' ? input.actor.id : undefined;
  if (userId === undefined) {
    return { ok: false, code: 'INVALID_CREDENTIAL', message: 'No account for this actor' };
  }

  // Step 1: the throttle runs before anything else, including the policy check — a locked caller
  // learns nothing more about the account's state (same discipline as update-account-profile.ts).
  const lockStatus = await deps.reauthGuard.check(userId);
  if (lockStatus.locked) {
    return {
      ok: false,
      code: 'REAUTH_LOCKED',
      message: 'Too many incorrect password attempts. Try again later.',
      retryAfterSeconds: lockStatus.retryAfterSeconds,
    };
  }

  // Step 2: the v0.1 policy, before any I/O a weak password would otherwise waste.
  const [row] = await deps.db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  const validated = validatePassword(input.newPassword, row ? { email: row.email } : {});
  if (!validated.ok) {
    return { ok: false, code: 'VALIDATION_FAILED', field: 'newPassword', message: WEAK_PASSWORD_MESSAGE };
  }

  // Step 3: who else is signed in right now — read BEFORE Better Auth deletes those rows.
  // `changePassword` itself reports no count at all (09-RESEARCH.md, pinned by password.test.ts's
  // own contract describe), so this is the only way to know `sessionsRevoked` (D-06).
  const others = await deps.db
    .select({ token: sessions.token, expiresAt: sessions.expiresAt })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), ne(sessions.id, input.sessionId)));

  // Step 4: the delegated change itself.
  let result: { headers: Headers };
  try {
    result = await deps.changePassword({
      body: { currentPassword: input.currentPassword, newPassword: input.newPassword, revokeOtherSessions: true },
      headers: input.headers,
      returnHeaders: true,
    });
  } catch (error) {
    if (isAPIError(error) && error.body?.code === 'INVALID_PASSWORD') {
      await deps.reauthGuard.recordFailure(userId);
      return {
        ok: false,
        code: 'INVALID_CREDENTIAL',
        field: 'currentPassword',
        message: 'Current password is incorrect.',
      };
    }
    // Any other Better Auth failure (PASSWORD_TOO_SHORT/TOO_LONG can never actually happen here —
    // `validatePassword` already enforces a stricter bound — or a genuine infrastructure error)
    // is rethrown for the route's global error handler to redact, exactly like every other
    // unexpected error in this codebase (D-22).
    throw error;
  }

  // Step 5: success bookkeeping — throttle cleared, revocation markers recorded, one activity
  // event with only the allowlisted count (D-08).
  await deps.reauthGuard.clear(userId);
  const now = deps.now();
  await recordPasswordChangeRevocations(deps.db, others, now);
  await writeActivityEvent(
    deps.db,
    {
      actorType: 'user',
      actorId: userId,
      entityType: 'user',
      entityId: userId,
      action: 'account.password_changed',
      outcome: 'success',
      metadata: { sessions_revoked: others.length },
    },
    now,
  );

  // Step 6: only the rotated session's own Set-Cookie values leave this service.
  return {
    ok: true,
    value: { sessionsRevoked: others.length, setCookies: result.headers.getSetCookie() },
  };
}
