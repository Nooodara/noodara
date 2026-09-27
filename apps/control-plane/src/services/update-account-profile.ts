// SET-02/D-02/D-03/D-08: `PATCH /api/account/profile`'s service. Confirms the current password
// against `accounts.password` (never `auth.api.signInEmail`, which mints a new session as a side
// effect — RESEARCH Anti-Patterns), throttles wrong attempts through `ReauthGuard` (T-09-01),
// checks the email domain through the injected `DnsChecker` only when the email actually changes
// (T-09-22: password verification always runs first, so a wrong password never triggers a DNS
// lookup), and writes exactly one allowlisted `account.*` activity event per changed field
// (D-08 — never the previous value, never the password or its hash).
//
// Never-reread-secret discipline (edit-server.ts's own precedent): `accounts.password` is read
// once, only to call `verifyPassword`, and is never logged, never returned, never placed in
// activity metadata.
import { and, eq } from 'drizzle-orm';
import { validateAccountEmail, validateName } from '@noodara/domain/validators';
import { writeActivityEvent } from '../activity/write-activity-event.js';
import type { DnsChecker } from '../auth/dns-checker.js';
import { verifyPassword } from '../auth/password-hasher.js';
import type { ReauthGuard } from '../auth/reauth-guard.js';
import type { Database } from '../db/client.js';
import { accounts, users } from '../db/schema/auth.js';
import type { ServiceActor } from './server-service-deps.js';

const CREDENTIAL_PROVIDER_ID = 'credential';
const USERS_EMAIL_LOWER_UNIQUE_CONSTRAINT = 'users_email_lower_idx';

export type UpdateAccountProfileFailureCode =
  | 'INVALID_CREDENTIAL'
  | 'VALIDATION_FAILED'
  | 'EMAIL_DOMAIN_UNRESOLVABLE'
  | 'EMAIL_DOMAIN_CHECK_UNAVAILABLE'
  | 'REAUTH_LOCKED'
  | 'NOT_FOUND';

export interface UpdateAccountProfileInput {
  readonly actor: ServiceActor;
  readonly name?: string;
  readonly email?: string;
  readonly currentPassword: string;
}

export type UpdateAccountProfileResult =
  | { readonly ok: true; readonly value: { readonly name: string; readonly email: string } }
  | {
      readonly ok: false;
      readonly code: UpdateAccountProfileFailureCode;
      readonly message: string;
      readonly field?: string;
      readonly retryAfterSeconds?: number;
    };

export interface UpdateAccountProfileDeps {
  readonly db: Database;
  readonly dnsChecker: DnsChecker;
  readonly reauthGuard: ReauthGuard;
  readonly now: () => Date;
}

/** A raw Postgres unique-violation error, as drizzle-orm 0.45 wraps it (same shape edit-server.ts
 *  and register-server.ts each already decode independently — this is the third, deliberately not
 *  extracted to a shared helper, matching that existing per-file duplication). */
function uniqueViolationConstraint(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: string; constraint?: string } } | undefined)?.cause;
  return cause?.code === '23505' ? cause.constraint : undefined;
}

/** Splits on the LAST '@' (RFC 5321 local parts may themselves contain '@' when quoted) to
 *  extract the domain for the DNS check. `validateAccountEmail` has already confirmed the input
 *  contains at least one '@', so `domain` is always defined here. */
function domainOf(email: string): string {
  const at = email.lastIndexOf('@');
  return email.slice(at + 1);
}

/** Reads the argon2id hash off the `accounts` row Better Auth's own email/password provider
 *  writes (`providerId = 'credential'`, its fixed constant — never `signInEmail`, which mints a
 *  new session as a side effect). A missing row or a null `password` column both fall through to
 *  the same "no hash to verify against" `undefined` — never a different code path an attacker
 *  could use to distinguish "no such account" from "wrong password" (T-09-09). */
async function fetchCredentialHash(db: Database, userId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ password: accounts.password })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.providerId, CREDENTIAL_PROVIDER_ID)))
    .limit(1);
  return row?.password ?? undefined;
}

/**
 * SET-02: verifies the current password (D-02), validates and applies a name and/or email edit,
 * checking the new email's domain (D-03) only when the email actually changes, and writes one
 * allowlisted `account.*` activity event per changed field (D-08) inside the same transaction as
 * the write.
 */
export async function updateAccountProfile(
  deps: UpdateAccountProfileDeps,
  input: UpdateAccountProfileInput,
): Promise<UpdateAccountProfileResult> {
  const userId = input.actor.type === 'user' ? input.actor.id : undefined;
  if (userId === undefined) {
    return { ok: false, code: 'NOT_FOUND', message: 'No account for this actor' };
  }

  // Step a: the throttle runs before anything else, including reading the stored hash — a locked
  // caller learns nothing more about the account's state.
  const lockStatus = await deps.reauthGuard.check(userId);
  if (lockStatus.locked) {
    return {
      ok: false,
      code: 'REAUTH_LOCKED',
      message: 'Too many incorrect password attempts. Try again later.',
      retryAfterSeconds: lockStatus.retryAfterSeconds,
    };
  }

  // Step b/c: read the credential hash once, verify, record the outcome against the throttle.
  const hash = await fetchCredentialHash(deps.db, userId);
  const verified = hash !== undefined && (await verifyPassword({ hash, password: input.currentPassword }));
  if (!verified) {
    await deps.reauthGuard.recordFailure(userId);
    return {
      ok: false,
      code: 'INVALID_CREDENTIAL',
      field: 'currentPassword',
      message: 'Current password is incorrect.',
    };
  }
  await deps.reauthGuard.clear(userId);

  // Step d: field validation, before any I/O that a bad input would otherwise waste (DNS, tx).
  let validatedName: string | undefined;
  if (input.name !== undefined) {
    const result = validateName(input.name);
    if (!result.ok) {
      return { ok: false, code: 'VALIDATION_FAILED', field: 'name', message: result.message };
    }
    validatedName = result.value;
  }

  let validatedEmail: string | undefined;
  if (input.email !== undefined) {
    const result = validateAccountEmail(input.email);
    if (!result.ok) {
      return { ok: false, code: 'VALIDATION_FAILED', field: 'email', message: result.message };
    }
    validatedEmail = result.value;
  }

  // Step e: the row this comparison and the DNS check both need, read before the transaction (and
  // its row lock) opens — a bounded DNS lookup must never hold a row lock while it runs (T-09-02).
  const [currentRow] = await deps.db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!currentRow) {
    return { ok: false, code: 'NOT_FOUND', message: 'Account not found' };
  }

  const emailChanged = validatedEmail !== undefined && validatedEmail !== currentRow.email.toLowerCase();
  if (emailChanged && validatedEmail !== undefined) {
    const outcome = await deps.dnsChecker.checkEmailDomain(domainOf(validatedEmail));
    if (outcome === 'unresolvable') {
      return {
        ok: false,
        code: 'EMAIL_DOMAIN_UNRESOLVABLE',
        field: 'email',
        message: "We couldn't find a mail server for this domain. Check the address and try again.",
      };
    }
    if (outcome === 'unavailable') {
      return {
        ok: false,
        code: 'EMAIL_DOMAIN_CHECK_UNAVAILABLE',
        field: 'email',
        message: "We couldn't check this domain right now. Try again in a moment.",
      };
    }
  }

  // Step f: the actual write, under a row lock, with an activity event per changed field.
  try {
    const result = await deps.db.transaction(async (tx) => {
      const [row] = await tx.select().from(users).where(eq(users.id, userId)).for('update');
      if (!row) {
        return { ok: false as const, code: 'NOT_FOUND' as const, message: 'Account not found' };
      }

      const nextName = validatedName ?? row.name;
      const nextEmail = validatedEmail ?? row.email;
      const nameChanged = validatedName !== undefined && validatedName !== row.name;
      const rowEmailChanged = validatedEmail !== undefined && validatedEmail !== row.email.toLowerCase();

      if (nameChanged || rowEmailChanged) {
        await tx
          .update(users)
          .set({
            ...(nameChanged ? { name: nextName } : {}),
            ...(rowEmailChanged ? { email: nextEmail } : {}),
            updatedAt: deps.now(),
          })
          .where(eq(users.id, userId));
      }

      if (nameChanged) {
        await writeActivityEvent(
          tx,
          {
            actorType: 'user',
            actorId: userId,
            entityType: 'user',
            entityId: userId,
            action: 'account.name_changed',
            outcome: 'success',
            metadata: { name: nextName },
          },
          deps.now(),
        );
      }
      if (rowEmailChanged) {
        await writeActivityEvent(
          tx,
          {
            actorType: 'user',
            actorId: userId,
            entityType: 'user',
            entityId: userId,
            action: 'account.email_changed',
            outcome: 'success',
            metadata: { email: nextEmail },
          },
          deps.now(),
        );
      }

      return { ok: true as const, value: { name: nextName, email: nextEmail } };
    });
    return result;
  } catch (error) {
    if (uniqueViolationConstraint(error) === USERS_EMAIL_LOWER_UNIQUE_CONSTRAINT) {
      return { ok: false, code: 'VALIDATION_FAILED', field: 'email', message: 'Enter a valid email address.' };
    }
    throw error;
  }
}
