import { sql } from 'drizzle-orm';
import { boolean, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';

// Better Auth's Drizzle adapter (wired in Plan 01-10) expects these four core tables. Column
// names follow Better Auth's own default schema (id/name/email/emailVerified/image, expiresAt/
// token/ipAddress/userAgent, accountId/providerId/password, identifier/value) so the adapter can
// bind to `schema/index.ts` without a custom `fields` remap.
//
// Every table in this project uses application-generated UUIDv7 primary keys — PostgreSQL 16/17
// has no native `uuidv7()` (RESEARCH Summary) — and `created_at`/`updated_at` timestamptz columns
// (01-CONTEXT.md "Convenciones de esquema").

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().$defaultFn(() => uuidv7()),
    name: text('name').notNull(),
    // Stored as-provided; uniqueness is enforced case-insensitively by the functional index below
    // rather than by a citext column, since this project does not depend on the citext extension.
    email: text('email').notNull(),
    emailVerified: boolean('email_verified').notNull().default(false),
    image: text('image'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('users_email_lower_idx').on(sql`lower(${table.email})`)],
);

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().$defaultFn(() => uuidv7()),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  // D-05: hard 30-day ceiling from login, tracked separately from Better Auth's own sliding
  // `expiresAt` because Better Auth's expiresIn/updateAge pair alone cannot express "sliding
  // renewal capped at an absolute date" (RESEARCH Assumption A2) — Plan 01-11 sets this.
  absoluteExpiresAt: timestamp('absolute_expires_at', { withTimezone: true }).notNull(),
  // D-06: multi-session listing shows each session's last activity.
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().$defaultFn(() => uuidv7()),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  // The argon2id hash (AUTH-02, Plan 01-10) — never plaintext.
  password: text('password'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const verifications = pgTable('verifications', {
  id: uuid('id').primaryKey().$defaultFn(() => uuidv7()),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
