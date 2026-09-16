import { index, jsonb, pgEnum, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';
import { servers, serverErrorCodeEnum } from './servers.js';

// D-06 (phase 3): append-only history of discovery runs. No service ever UPDATEs or DELETEs a
// row here directly — the only way a row disappears is the server it belongs to being deleted
// (D-08's FK cascade below). `payload` stores the `DiscoverySnapshot` shape
// (packages/domain/src/discovery/types.ts) verbatim, never normalized into columns, so this table
// never needs a migration when a new discovery fact is added. Retention is unlimited in v0.1.
export const discoveryOutcomeEnum = pgEnum('discovery_outcome', ['ok', 'partial', 'failed']);

export const discoverySnapshots = pgTable(
  'discovery_snapshots',
  {
    id: uuid('id').primaryKey().$defaultFn(() => uuidv7()),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    collectedAt: timestamp('collected_at', { withTimezone: true }).notNull(),
    outcome: discoveryOutcomeEnum('outcome').notNull(),
    // Reuses server_error_code (no new enum): a discovery run's warning/error, when present, is
    // always one of the same ServerErrorCode values a connection result can produce.
    errorCode: serverErrorCodeEnum('error_code'),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Phase-5 server-detail history reads most-recent-first per server.
    index('discovery_snapshots_server_id_collected_at_idx').on(
      table.serverId,
      table.collectedAt.desc(),
    ),
  ],
);
