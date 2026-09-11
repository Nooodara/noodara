// D-01/D-02/D-03: all `setup_tokens` row access lives here — the setup service (this plan) and
// the future `noodara admin reset` CLI (Plan 01-14) both go through these three functions rather
// than querying the table directly, so the table's one behavioral rule ("only the hash is ever
// stored") has exactly one enforcement point.
import { and, eq } from 'drizzle-orm';
import {
  generateSetupToken,
  hashSetupToken,
  revealSecret,
  SETUP_TOKEN_TTL_SECONDS,
  type SecretValue,
  type SetupTokenPurpose,
} from '@noodara/domain/security';
import type { ActivityWriteHandle } from '../activity/write-activity-event.js';
import { setupTokens } from '../db/schema/setup-tokens.js';

export type SetupTokenRow = typeof setupTokens.$inferSelect;

export interface IssuedSetupToken {
  readonly id: string;
  /** The raw, revealed token value — exists only long enough for the caller to hand it to stdout
   *  (D-01) or the operator (D-03). Never persisted; only `hashSetupToken(...)` of it is. */
  readonly token: SecretValue;
  readonly expiresAt: Date;
}

/**
 * Generates a fresh token, persists only its hash, and returns the raw value to the caller.
 * `handle` accepts either the default db handle or a transaction, so a future caller (e.g. the
 * `admin reset` CLI writing its own activity event) can issue a token atomically with other work.
 */
export async function issueToken(
  handle: ActivityWriteHandle,
  purpose: SetupTokenPurpose,
  now: Date,
): Promise<IssuedSetupToken> {
  const token = generateSetupToken();
  const tokenHash = hashSetupToken(revealSecret(token));
  const expiresAt = new Date(now.getTime() + SETUP_TOKEN_TTL_SECONDS * 1000);

  const [row] = await handle
    .insert(setupTokens)
    .values({ tokenHash, purpose, expiresAt })
    .returning({ id: setupTokens.id });
  if (!row) {
    throw new Error('issueToken: insert returned no row');
  }

  return { id: row.id, token, expiresAt };
}

/**
 * Fetches the token row matching `tokenHash` and `purpose`, if any, locking it `FOR UPDATE` so a
 * concurrent redemption of the very same row waits behind this transaction (T-1-34) rather than
 * reading a stale, not-yet-marked-used state. Usability itself (used? expired?) is the caller's
 * job via `isTokenUsable` — this function only fetches; it never decides.
 */
export async function findUsableByHash(
  handle: ActivityWriteHandle,
  tokenHash: string,
  purpose: SetupTokenPurpose,
): Promise<SetupTokenRow | undefined> {
  const [row] = await handle
    .select()
    .from(setupTokens)
    .where(and(eq(setupTokens.tokenHash, tokenHash), eq(setupTokens.purpose, purpose)))
    .for('update');
  return row;
}

/** Marks a token row as redeemed. Must run in the same transaction as whatever the token
 *  authorized (T-1-35: replay is only closed if this and the authorized action commit together). */
export async function markUsed(handle: ActivityWriteHandle, id: string, now: Date): Promise<void> {
  await handle.update(setupTokens).set({ usedAt: now }).where(eq(setupTokens.id, id));
}
