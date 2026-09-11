import { index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';

// AUTH-04 / noodara-domain-model skill §7: only auth actions are emitted this phase (setup,
// login, login failure, logout, session revoked, recovery) — the general activity-log service
// and its non-auth action union members land in phase 3.
export const activityActorTypeEnum = pgEnum('activity_actor_type', ['user', 'system']);
export const activityOutcomeEnum = pgEnum('activity_outcome', ['success', 'failure']);

export const activityEvents = pgTable(
  'activity_events',
  {
    id: uuid('id').primaryKey().$defaultFn(() => uuidv7()),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    actorType: activityActorTypeEnum('actor_type').notNull(),
    // No FK to `users`: an audit trail must survive the actor being deleted.
    actorId: uuid('actor_id'),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),
    action: text('action').notNull(),
    outcome: activityOutcomeEnum('outcome').notNull(),
    errorCode: text('error_code'),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Phase-5 reverse-chronological activity list reads most-recent-first.
    index('activity_events_occurred_at_idx').on(table.occurredAt.desc()),
  ],
);
