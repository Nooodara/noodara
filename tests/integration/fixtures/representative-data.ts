import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { Database } from '../../../apps/control-plane/src/db/client.js';
import * as schema from '../../../apps/control-plane/src/db/schema/index.js';
import { encryptSecret, type EncryptionKey } from '../../../packages/domain/src/security/envelope.js';

/**
 * A fixed, in-memory-only key (never a real `NOODARA_MASTER_KEY`) used solely to produce a real
 * AES-256-GCM envelope for the seeded credential row, so the migration test exercises the exact
 * stored format (`v<version>:<nonce>:<ciphertext>:<tag>`, D-10) instead of a fake placeholder
 * string that a future encrypted-column migration would never actually validate against.
 */
const SEED_ENCRYPTION_KEY: EncryptionKey = { key: randomBytes(32), version: 1 };

export interface RepresentativeDataIds {
  readonly userId: string;
  readonly accountId: string;
  readonly sessionId: string;
  readonly verificationId: string;
  readonly setupTokenId: string;
  readonly loginAttemptId: string;
  readonly credentialId: string;
  readonly serverId: string;
  readonly activityEventId: string;
}

function assertDefined<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`expected ${what} insert to return a row`);
  }
  return value;
}

/**
 * Inserts one representative row into every table that exists at the previous-migration
 * snapshot (PITFALLS.md #10 / 01-CONTEXT.md "Tests de migracion"): a user, an account, a
 * session, a verification, a setup token, a login attempt, a real encrypted credential, a
 * server referencing that credential, and an activity event. Returns only the inserted ids
 * (never full rows) so the from-snapshot migration test looks rows up by id after the upgrade
 * step rather than by scanning the table.
 */
export async function seedRepresentativeData(db: Database): Promise<RepresentativeDataIds> {
  const insertedUsers = await db
    .insert(schema.users)
    .values({ name: 'Ada Lovelace', email: 'ada@example.com' })
    .returning();
  const user = assertDefined(insertedUsers[0], 'user');

  const insertedAccounts = await db
    .insert(schema.accounts)
    .values({
      accountId: user.email,
      providerId: 'credential',
      userId: user.id,
      password: 'argon2id$v=19$m=65536,t=3,p=4$fixture-salt$fixture-hash',
    })
    .returning();
  const account = assertDefined(insertedAccounts[0], 'account');

  const insertedSessions = await db
    .insert(schema.sessions)
    .values({
      userId: user.id,
      token: `representative-session-${randomBytes(16).toString('hex')}`,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      absoluteExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      ipAddress: '203.0.113.10',
      userAgent: 'representative-data-fixture/1.0',
    })
    .returning();
  const session = assertDefined(insertedSessions[0], 'session');

  const insertedVerifications = await db
    .insert(schema.verifications)
    .values({
      identifier: user.email,
      value: randomBytes(16).toString('hex'),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })
    .returning();
  const verification = assertDefined(insertedVerifications[0], 'verification');

  const insertedSetupTokens = await db
    .insert(schema.setupTokens)
    .values({
      tokenHash: randomBytes(32).toString('hex'),
      purpose: 'setup',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    })
    .returning();
  const setupToken = assertDefined(insertedSetupTokens[0], 'setup token');

  // Raw SQL restricted to the columns present in the *previous* migration snapshot (0000) —
  // Plan 01-13's migration 0001 added `lockout_count`, which does not exist yet in the database
  // at the point this fixture seeds data for the from-snapshot upgrade test (PITFALLS.md #10's
  // own scenario, now real: the current `schema.loginAttempts` module reflects the *latest*
  // migration, not necessarily the one applied so far, so `db.insert(schema.loginAttempts)`
  // here would reference a column that has not been created yet).
  const loginAttemptId = uuidv7();
  const insertedLoginAttempts = await db.execute<{ id: string }>(sql`
    insert into login_attempts (id, scope, scope_key, failure_count, last_failure_at)
    values (${loginAttemptId}, 'account', ${user.email}, 2, now())
    returning id
  `);
  const loginAttempt = assertDefined(insertedLoginAttempts.rows[0], 'login attempt');

  const encryptedValue = encryptSecret('representative-ssh-key-material', SEED_ENCRYPTION_KEY);
  const insertedCredentials = await db
    .insert(schema.credentials)
    .values({
      type: 'ssh_password',
      encryptedValue,
      keyVersion: SEED_ENCRYPTION_KEY.version,
    })
    .returning();
  const credential = assertDefined(insertedCredentials[0], 'credential');

  // Raw SQL restricted to the columns present in the *previous* migration snapshot (0001) — this
  // plan's migration 0002 adds host_fingerprint_captured_at/pending_fingerprint_seen_at, which do
  // not exist yet in the database at the point this fixture seeds data for the from-snapshot
  // upgrade test (the same pattern login_attempts/lockout_count already established above).
  // host_fingerprint is set to a realistic pinned value in the `ssh-ed25519 SHA256:...` shape
  // (D-05) so the upgrade is exercised against a row that actually has a fingerprint.
  const serverId = uuidv7();
  const insertedServers = await db.execute<{
    id: string;
    credential_id: string;
    status: string;
  }>(sql`
    insert into servers (id, name, host, ssh_user, credential_id, status, host_fingerprint)
    values (
      ${serverId},
      'representative-server',
      '198.51.100.20',
      'deploy',
      ${credential.id},
      'CONNECTED',
      'ssh-ed25519 SHA256:AbCdEf0123456789AbCdEf0123456789AbCdEf01234'
    )
    returning id, credential_id, status
  `);
  const server = assertDefined(insertedServers.rows[0], 'server');

  const insertedActivityEvents = await db
    .insert(schema.activityEvents)
    .values({
      occurredAt: new Date(),
      actorType: 'user',
      actorId: user.id,
      entityType: 'server',
      entityId: server.id,
      action: 'server.connect',
      outcome: 'success',
    })
    .returning();
  const activityEvent = assertDefined(insertedActivityEvents[0], 'activity event');

  return {
    userId: user.id,
    accountId: account.id,
    sessionId: session.id,
    verificationId: verification.id,
    setupTokenId: setupToken.id,
    loginAttemptId: loginAttempt.id,
    credentialId: credential.id,
    serverId: server.id,
    activityEventId: activityEvent.id,
  };
}

/**
 * Inserts one representative row into `discovery_snapshots` (D-06) for `serverId`. Only usable
 * AFTER the from-snapshot upgrade step has run migration 0003 — the table does not exist at the
 * 0002 snapshot `seedRepresentativeData` above is restricted to. Returns the inserted row's id.
 */
export async function seedDiscoverySnapshot(db: Database, serverId: string): Promise<string> {
  const insertedSnapshots = await db.execute<{ id: string }>(sql`
    insert into discovery_snapshots (id, server_id, collected_at, outcome, error_code, payload)
    values (
      ${uuidv7()},
      ${serverId},
      now(),
      'partial',
      'COMMAND_TIMEOUT',
      ${JSON.stringify({
        facts: {
          hostname: 'representative-host',
          osDistribution: 'ubuntu',
          osVersion: '24.04',
          arch: 'x86_64',
          cpuCores: 4,
          ramMb: 8192,
          diskTotalMb: 102400,
          diskUsedMb: 20480,
          uptimeSeconds: 3600,
          dockerInstalled: true,
          dockerVersion: '27.3.1',
          dockerComposeVersion: null,
        },
        checks: [{ id: 'hostname', status: 'pass', detail: 'representative-host', durationMs: 12 }],
        warnings: [],
      })}::jsonb
    )
    returning id
  `);
  const snapshot = assertDefined(insertedSnapshots.rows[0], 'discovery snapshot');
  return snapshot.id;
}
