import { integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';

// D-07: Better Auth's own `rateLimit` is IP+path keyed only (RESEARCH Pitfall 2), so counting is
// done here, independently, by IP and by account.
export const loginAttemptScopeEnum = pgEnum('login_attempt_scope', ['ip', 'account']);

export const loginAttempts = pgTable(
  'login_attempts',
  {
    id: uuid('id').primaryKey().$defaultFn(() => uuidv7()),
    scope: loginAttemptScopeEnum('scope').notNull(),
    // The raw IP string when scope='ip', the lowercased email when scope='account'.
    scopeKey: text('scope_key').notNull(),
    failureCount: integer('failure_count').notNull().default(0),
    windowStartedAt: timestamp('window_started_at', { withTimezone: true }).notNull().defaultNow(),
    // D-07: doubling backoff (15min -> 30 -> 60 -> ... -> 24h), never permanent.
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lastFailureAt: timestamp('last_failure_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // IP and account counters are independent (D-07): one row per (scope, scope_key) pair.
    uniqueIndex('login_attempts_scope_key_idx').on(table.scope, table.scopeKey),
  ],
);
