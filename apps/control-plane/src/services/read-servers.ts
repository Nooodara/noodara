// D-19/SERV-06: the read side of the server resource. Every phase-3 mutating service already
// returns a `ServerView` from its own transactional write — these two functions give phase 4's
// HTTP routes the same projection for `GET /api/servers` and `GET /api/servers/:id`, without
// opening a transaction of their own (a read is not a mutation) and without ever recording an
// activity event (a read is not an event either, ACT-01).
import { asc, eq } from 'drizzle-orm';
import { credentials } from '../db/schema/credentials.js';
import { servers } from '../db/schema/servers.js';
import type { ServerServicesDeps } from './server-service-deps.js';
import { toServerView, type ServerView } from './server-view.js';

/**
 * Returns the `ServerView` for `serverId`, or `null` when no such server exists — absence is the
 * answer here, never a `{ ok, code }` result union (there is no failure mode to report beyond "no
 * row"), and never a thrown exception.
 */
export async function getServerView(
  deps: ServerServicesDeps,
  serverId: string,
): Promise<ServerView | null> {
  const [row] = await deps.db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
  if (!row) {
    return null;
  }

  const [credentialRow] = await deps.db
    .select({ type: credentials.type })
    .from(credentials)
    .where(eq(credentials.id, row.credentialId))
    .limit(1);
  if (!credentialRow) {
    throw new Error(`getServerView: credential ${row.credentialId} not found`);
  }

  return toServerView(row, credentialRow.type);
}

/**
 * Every server, ordered by `name` ascending — consistent with the `lower(name)` unique index
 * (D-10), so two names differing only by case still sort adjacently. No pagination: D-19 is
 * explicit that one admin with dozens of servers does not need it.
 */
export async function listServerViews(deps: ServerServicesDeps): Promise<ServerView[]> {
  const rows = await deps.db.select().from(servers).orderBy(asc(servers.name));
  if (rows.length === 0) {
    return [];
  }

  const credentialRows = await deps.db.select().from(credentials);
  const credentialTypeById = new Map(credentialRows.map((row) => [row.id, row.type]));

  return rows.map((row) => {
    const credentialType = credentialTypeById.get(row.credentialId);
    if (credentialType === undefined) {
      throw new Error(`listServerViews: credential ${row.credentialId} not found`);
    }
    return toServerView(row, credentialType);
  });
}
