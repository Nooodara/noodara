import { sql } from 'drizzle-orm';
import { pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';

// D-01/D-02/D-03: the setup token and the CLI recovery token share this one table, distinguished
// by `purpose`. Only `token_hash` is ever stored — the raw, unhashed token exists only in memory
// long enough to print it to stdout (setup) or hand it to the operator (recovery).
export const setupTokenPurposeEnum = pgEnum('setup_token_purpose', ['setup', 'recovery']);

export const setupTokens = pgTable(
  'setup_tokens',
  {
    id: uuid('id').primaryKey().$defaultFn(() => uuidv7()),
    tokenHash: text('token_hash').notNull().unique(),
    purpose: setupTokenPurposeEnum('purpose').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Database-level backstop for the "first visitor becomes admin" race (T-1-17): at most one
    // *unused* token per purpose can exist at a time. Postgres partial-index predicates must be
    // IMMUTABLE, so `expires_at > now()` cannot appear here (`now()` is STABLE, not IMMUTABLE) —
    // `used_at IS NULL` is the enforceable subset of "unused and unexpired", and it is strictly
    // safe: an application-level expiry check still gates whether an unused-but-expired token can
    // be redeemed, while this index guarantees only one live candidate row ever exists.
    uniqueIndex('setup_tokens_active_purpose_idx')
      .on(table.purpose)
      .where(sql`${table.usedAt} IS NULL`),
  ],
);
