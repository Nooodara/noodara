// T-09-10 (D-05/D-07): a password change (D-05) revokes every other session by deleting its row
// (Better Auth's own `changePassword` behaviour, pinned by password.test.ts's contract describe).
// A deleted row means `requireSession`'s ordinary `getSession` lookup returns nothing at all for
// a stale cookie — indistinguishable from "never logged in" — so a revoked tab's heartbeat would
// otherwise see a plain `UNAUTHORIZED` and never learn *why* (D-07 needs a distinct reason).
//
// This module records that reason separately, in Better Auth's own `verifications` table (no
// migration needed — the table already exists for Better Auth's own use, and a prefixed
// `identifier` cannot collide with anything Better Auth itself ever writes there). Only a sha256
// hash of the revoked token is stored, never the raw token — a leaked `verifications` row must
// not be a usable session credential.
import { createHash } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { verifications } from '../db/schema/auth.js';

export const REVOCATION_IDENTIFIER_PREFIX = 'session-revoked:';

export type RevocationReason = 'password_changed';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function identifierFor(token: string): string {
  return `${REVOCATION_IDENTIFIER_PREFIX}${hashToken(token)}`;
}

/**
 * Records one `verifications` row per revoked session, expiring alongside that session's own
 * `expiresAt` (a marker for a session that could never have authenticated again anyway is
 * pointless to keep). A no-op for an empty list (a single-session admin, D-05's `sessionsRevoked:
 * 0` case) — never an empty `INSERT`.
 */
export async function recordPasswordChangeRevocations(
  db: Database,
  sessions: readonly { token: string; expiresAt: Date }[],
  now: Date,
): Promise<void> {
  if (sessions.length === 0) return;
  await db.insert(verifications).values(
    sessions.map((session) => ({
      identifier: identifierFor(session.token),
      value: 'password_changed' satisfies RevocationReason,
      expiresAt: session.expiresAt,
      createdAt: now,
      updatedAt: now,
    })),
  );
}

/** Returns the recorded reason for `token` if a matching, unexpired marker exists — `null` for an
 *  unknown or expired token (never throws, never distinguishes the two to a caller). */
export async function findRevocationReason(db: Database, token: string, now: Date): Promise<RevocationReason | null> {
  const [row] = await db
    .select({ value: verifications.value })
    .from(verifications)
    .where(and(eq(verifications.identifier, identifierFor(token)), gt(verifications.expiresAt, now)))
    .limit(1);
  return row?.value === 'password_changed' ? 'password_changed' : null;
}
