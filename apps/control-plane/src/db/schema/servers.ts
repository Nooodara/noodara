import { boolean, integer, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';
import { SERVER_ERROR_CODES, SERVER_STATUSES } from '@noodara/domain/server';
import { credentials } from './credentials.js';

// Enums derived from the domain constants (SERV-05) so the database enum and the TypeScript union
// in packages/domain cannot drift — a new status/error code always starts as a domain change.
export const serverStatusEnum = pgEnum('server_status', [...SERVER_STATUSES]);
export const serverErrorCodeEnum = pgEnum('server_error_code', [...SERVER_ERROR_CODES]);

// Every column phases 2 and 3 will fill (fingerprints, denormalised discovery fields,
// last_seen_at, last_error_code) already exists here (01-CONTEXT.md Integration Points), so no
// shape migration is needed once the SSH adapter and discovery land.
export const servers = pgTable('servers', {
  id: uuid('id').primaryKey().$defaultFn(() => uuidv7()),
  name: text('name').notNull(),
  host: text('host').notNull(),
  sshPort: integer('ssh_port').notNull().default(22),
  sshUser: text('ssh_user').notNull(),
  credentialId: uuid('credential_id')
    .notNull()
    .references(() => credentials.id),
  status: serverStatusEnum('status').notNull().default('PENDING'),
  hostFingerprint: text('host_fingerprint'),
  // D-15: HOST_KEY_CHANGED parks the newly observed fingerprint here until an explicit
  // "Trust new fingerprint" action copies it into host_fingerprint (Plan 01-04's
  // applyConnectionResult / server-state.ts transition() already models this edge).
  pendingFingerprint: text('pending_fingerprint'),
  // Discovery fields (phase 2/3) — nullable until a connection/discovery run fills them in.
  hostname: text('hostname'),
  osDistribution: text('os_distribution'),
  osVersion: text('os_version'),
  arch: text('arch'),
  cpuCores: integer('cpu_cores'),
  ramMb: integer('ram_mb'),
  diskTotalMb: integer('disk_total_mb'),
  diskUsedMb: integer('disk_used_mb'),
  uptimeSeconds: integer('uptime_seconds'),
  dockerInstalled: boolean('docker_installed'),
  dockerVersion: text('docker_version'),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  lastErrorCode: serverErrorCodeEnum('last_error_code'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
