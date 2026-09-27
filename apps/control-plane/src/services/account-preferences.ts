// SET-04/SET-05/D-16: `GET`/`PATCH /api/account/preferences`'s service. The server is the source
// of truth for theme/reduceMotion/density (D-10) -- every read goes through
// `resolveStoredPreferences` so a corrupted jsonb value never breaks a response (T-09-26), and
// every write locks the row first (`edit-server.ts`'s own `for('update')` precedent) so a
// concurrent PATCH from two tabs never loses one of the two fields being changed. Deliberately
// never records an activity event (D-08): appearance changes are not audited.
import { eq } from 'drizzle-orm';
import {
  mergePreferences,
  resolveStoredPreferences,
  type Preferences,
  type PreferencesPatch,
} from '@noodara/domain/preferences';
import type { Database } from '../db/client.js';
import { users } from '../db/schema/auth.js';

// The route always calls with `request.actor.id` from an already-validated session, so a missing
// row here would only ever mean the user was deleted mid-session -- this codebase has no such
// flow yet, but the code is declared so a future caller (and http-errors.test.ts's static
// exhaustiveness scan) has a mapped status ready rather than a silent 500.
export type AccountPreferencesFailureCode = 'NOT_FOUND';

export interface AccountPreferencesDeps {
  readonly db: Database;
}

/** SET-04/SET-05: reads `users.preferences` for `actorId`, resolved through the lenient decoder so
 *  a corrupted field defaults on its own rather than discarding the whole row (T-09-26). A missing
 *  row (no such user) resolves to `DEFAULT_PREFERENCES` via the same decoder, matching a brand new
 *  admin's own first-ever GET. */
export async function readAccountPreferences(deps: AccountPreferencesDeps, actorId: string): Promise<Preferences> {
  const [row] = await deps.db
    .select({ preferences: users.preferences })
    .from(users)
    .where(eq(users.id, actorId))
    .limit(1);
  return resolveStoredPreferences(row?.preferences);
}

/**
 * SET-04/SET-05/D-16: applies a validated partial patch on top of the actor's current
 * preferences, inside a row-locked transaction, and returns the full merged result. Never writes
 * an activity event (D-08).
 */
export async function updateAccountPreferences(
  deps: AccountPreferencesDeps,
  actorId: string,
  patch: PreferencesPatch,
): Promise<Preferences> {
  return deps.db.transaction(async (tx) => {
    const [row] = await tx.select().from(users).where(eq(users.id, actorId)).for('update');
    const current = resolveStoredPreferences(row?.preferences);
    const merged = mergePreferences(current, patch);

    await tx.update(users).set({ preferences: merged, updatedAt: new Date() }).where(eq(users.id, actorId));

    return merged;
  });
}
