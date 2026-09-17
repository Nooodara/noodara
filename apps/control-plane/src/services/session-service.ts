// D-06 application service: wraps the session data Better Auth manages (and the auth-check it
// exposes) with the three operations the admin-facing routes need — list, revoke one, revoke all
// others. ARCHITECTURE.md §6: this is the only file besides write-activity-event.ts's own callers
// that writes `auth.session_revoked` rows, and it does so through `writeActivityEvent`.
//
// Listing and the ownership check behind every revocation query the `sessions` table directly
// through this app's own Drizzle handle, rather than through `auth.api.listSessions`/
// `revokeSession`/`revokeOtherSessions`. Two reasons, both confirmed by reading the installed
// `better-auth` source (not assumed from docs prose):
//   1. `revokeSession`'s own endpoint is keyed by `token`, not by our `sessions.id`, and it
//      silently no-ops (`{status: true}`) for a token that does not belong to the caller — it
//      never surfaces the not-my-session 404 T-1-32 requires. Better Auth's own db pool (opened
//      inside auth.ts) is also a separate connection from this app's `getDb()`, so a call through
//      `auth.api.*` could never share one Postgres transaction with `writeActivityEvent` anyway.
//   2. `auth.api.listSessions`'s parsed output strips every `additionalFields` entry whose
//      `returned` is not explicitly `true` — `lastSeenAt` (session-policy.ts) is exactly such a
//      field, and D-06 requires it in the listing.
// `auth.api.getSession` is still the one Better Auth call used here — for authentication only, to
// resolve the caller's current user id and session id from their cookie.
import { and, eq, ne } from 'drizzle-orm';
import type { AuthAction } from '@noodara/domain/activity';
import { auth } from '../auth/auth.js';
import { writeActivityEvent } from '../activity/write-activity-event.js';
import { getDb } from '../db/client.js';
import { sessions } from '../db/schema/auth.js';

// D-17 (Plan 04-02): `toFetchHeaders` moved to `auth/fetch-headers.ts` (zero-dependency, so
// `require-session.test.ts` can import it with no database connection). Re-exported here so
// `routes/sessions.ts`'s existing import path keeps working unchanged.
export { toFetchHeaders } from '../auth/fetch-headers.js';

const SESSION_REVOKED: AuthAction = 'auth.session_revoked';

export class UnauthorizedError extends Error {
  constructor() {
    super('No active session for the supplied headers');
    this.name = 'UnauthorizedError';
  }
}

export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`No session "${sessionId}" belongs to the authenticated caller`);
    this.name = 'SessionNotFoundError';
  }
}

export interface SessionListItem {
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  expiresAt: string;
  isCurrent: boolean;
}

interface CurrentSession {
  userId: string;
  sessionId: string;
}

async function requireCurrentSession(headers: Headers): Promise<CurrentSession> {
  const result = await auth.api.getSession({ headers });
  if (!result?.session) {
    throw new UnauthorizedError();
  }
  return { userId: result.user.id, sessionId: result.session.id };
}

export async function listSessions(headers: Headers): Promise<SessionListItem[]> {
  const { userId, sessionId } = await requireCurrentSession(headers);
  const db = await getDb();
  const now = new Date();

  const rows = await db.select().from(sessions).where(eq(sessions.userId, userId));

  return rows
    .filter((row) => row.expiresAt > now)
    .map((row) => ({
      id: row.id,
      userAgent: row.userAgent,
      ipAddress: row.ipAddress,
      createdAt: row.createdAt.toISOString(),
      lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
      expiresAt: row.expiresAt.toISOString(),
      isCurrent: row.id === sessionId,
    }));
}

/** Revokes `sessionId` if (and only if) it belongs to the authenticated caller. Throws
 *  `SessionNotFoundError` for a missing or not-owned id — the route maps both to 404, never 403,
 *  so the endpoint never confirms whether a given id belongs to some other user (T-1-32). */
export async function revokeSession(headers: Headers, sessionId: string): Promise<void> {
  const { userId } = await requireCurrentSession(headers);
  const db = await getDb();

  const [target] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)));
  if (!target) {
    throw new SessionNotFoundError(sessionId);
  }

  await db.transaction(async (tx) => {
    await tx.delete(sessions).where(eq(sessions.id, sessionId));
    await writeActivityEvent(tx, {
      actorType: 'user',
      actorId: userId,
      entityType: 'session',
      entityId: sessionId,
      action: SESSION_REVOKED,
      outcome: 'success',
      metadata: { sessionId, revokedBy: userId },
    });
  });
}

/** Revokes every session belonging to the caller except the one making this request. Returns the
 *  number of sessions revoked. */
export async function revokeOtherSessions(headers: Headers): Promise<number> {
  const { userId, sessionId: currentSessionId } = await requireCurrentSession(headers);
  const db = await getDb();

  const others = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), ne(sessions.id, currentSessionId)));
  if (others.length === 0) {
    return 0;
  }

  await db.transaction(async (tx) => {
    for (const other of others) {
      await tx.delete(sessions).where(eq(sessions.id, other.id));
      await writeActivityEvent(tx, {
        actorType: 'user',
        actorId: userId,
        entityType: 'session',
        entityId: other.id,
        action: SESSION_REVOKED,
        outcome: 'success',
        metadata: { sessionId: other.id, revokedBy: userId },
      });
    }
  });

  return others.length;
}
