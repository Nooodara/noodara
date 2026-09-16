import { sql } from 'drizzle-orm';
import {
  boolean,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';
import { SERVER_ERROR_CODES, SERVER_STATUSES } from '@noodara/domain/server';
import { credentials } from './credentials.js';

// Enums derived from the domain constants (SERV-05) so the database enum and the TypeScript union
// in packages/domain cannot drift — a new status/error code always starts as a domain change.
export const serverStatusEnum = pgEnum('server_status', [...SERVER_STATUSES]);
export const serverErrorCodeEnum = pgEnum('server_error_code', [...SERVER_ERROR_CODES]);

// Every discovery/fingerprint column phase 2 fills already exists here (01-CONTEXT.md Integration
// Points), with one exception: migration 0002 adds the two fingerprint capture timestamps (D-06)
// below, because the connection-result contract needs both fingerprint dates, and that shape did
// not exist before phase 2's own context.
export const servers = pgTable(
  'servers',
  {
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
    // D-06: stamped when a first-connect capture is persisted into host_fingerprint (D-07).
    hostFingerprintCapturedAt: timestamp('host_fingerprint_captured_at', { withTimezone: true }),
    // D-06: stamped when a HOST_KEY_CHANGED outcome parks an observed fingerprint into
    // pending_fingerprint (D-15 from phase 1's server-state.ts transition()).
    pendingFingerprintSeenAt: timestamp('pending_fingerprint_seen_at', { withTimezone: true }),
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
    // D-09 (phase 3): nullable, backfills NULL for pre-existing rows; filled by the same discovery
    // run that fills dockerVersion.
    dockerComposeVersion: text('docker_compose_version'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    lastErrorCode: serverErrorCodeEnum('last_error_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // D-10: case-insensitive name uniqueness enforced at the database, so a bypassed service
    // check cannot register two servers whose names differ only by case.
    uniqueIndex('servers_name_lower_unique_idx').on(sql`lower(${table.name})`),
    // D-10: a (host, ssh_port) pair identifies one server; two different names must not both
    // target the same host:port.
    uniqueIndex('servers_host_port_unique_idx').on(table.host, table.sshPort),
  ],
);
