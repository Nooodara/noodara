import { readFileSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterEach, describe, expect, it } from 'vitest';
import type { Database } from '../../../apps/control-plane/src/db/client.js';
import { MIGRATIONS_FOLDER, runMigrations } from '../../../apps/control-plane/src/db/migrate.js';
import * as schema from '../../../apps/control-plane/src/db/schema/index.js';
import {
  seedDiscoverySnapshot,
  seedRepresentativeData,
  type RepresentativeDataIds,
} from '../fixtures/representative-data.js';
import { applyMigrationsUpTo, readJournal } from '../helpers/migrations.js';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';

// Kept in sync with tests/integration/db/schema.test.ts's own list — both prove the same schema,
// one via startPostgres()'s default full migrate, this file via the journal-driven helper.
const EXPECTED_TABLES = [
  'users',
  'sessions',
  'accounts',
  'verifications',
  'setup_tokens',
  'login_attempts',
  'servers',
  'credentials',
  'activity_events',
  'discovery_snapshots',
  'projects',
  'environments',
  'services',
  'deployments',
  'deployment_log_chunks',
];

const EXPECTED_ENUMS = [
  'server_status',
  'server_error_code',
  'setup_token_purpose',
  'credential_type',
  'login_attempt_scope',
  'activity_actor_type',
  'activity_outcome',
  'service_source_type',
  'service_status',
  'deployment_status',
  'deployment_trigger',
  'deployment_error_code',
  'deployment_log_phase',
];

async function listTableNames(db: Database): Promise<string[]> {
  const result = await db.execute<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = 'public'",
  );
  return result.rows.map((row) => row.table_name);
}

async function listEnumNames(db: Database): Promise<string[]> {
  const result = await db.execute<{ typname: string }>(
    "select typname from pg_type where typtype = 'e'",
  );
  return result.rows.map((row) => row.typname);
}

async function countBookkeepingRows(db: Database): Promise<number> {
  const result = await db.execute<{ count: number }>(
    sql`select count(*)::int as count from "drizzle"."__drizzle_migrations"`,
  );
  return result.rows[0]?.count ?? 0;
}

/**
 * Fetches every row `seedRepresentativeData` inserted, by id — used to snapshot the data both
 * before and after the upgrade step so the from-snapshot test can assert field-identical survival
 * without hardcoding the fixture's own field values in the test itself.
 */
async function fetchSeededSnapshot(db: Database, ids: RepresentativeDataIds) {
  // Raw SQL restricted to the columns present in the *previous* migration snapshot (0003): this
  // plan's migration 0004 adds `preferences`, which does not exist yet when this function is
  // called for the "before" snapshot (same pattern as the login_attempts/servers cases below).
  const userResult = await db.execute<{
    id: string;
    name: string;
    email: string;
    email_verified: boolean;
    image: string | null;
    created_at: string;
    updated_at: string;
  }>(sql`
    select id, name, email, email_verified, image, created_at, updated_at
    from users where id = ${ids.userId}
  `);
  const user = userResult.rows[0];
  const [account] = await db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.id, ids.accountId));
  const [session] = await db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.id, ids.sessionId));
  const [verification] = await db
    .select()
    .from(schema.verifications)
    .where(eq(schema.verifications.id, ids.verificationId));
  const [setupToken] = await db
    .select()
    .from(schema.setupTokens)
    .where(eq(schema.setupTokens.id, ids.setupTokenId));
  // Raw SQL restricted to the columns present in the *previous* migration snapshot (0000): this
  // snapshot is taken both before and after the upgrade step, and `schema.loginAttempts` (the
  // current code's schema module) includes `lockout_count`, a column migration 0001 adds — that
  // column does not exist yet when this function is called for the "before" snapshot, so
  // selecting through the ORM's full column list would fail exactly like the fixture's insert
  // would (see representative-data.ts's own comment on the same issue).
  const loginAttemptResult = await db.execute<{
    id: string;
    scope: string;
    scope_key: string;
    failure_count: number;
    last_failure_at: string | null;
  }>(sql`select id, scope, scope_key, failure_count, last_failure_at from login_attempts where id = ${ids.loginAttemptId}`);
  const loginAttempt = loginAttemptResult.rows[0];
  // Raw SQL restricted to the columns present in the *previous* migration snapshot (0004):
  // migration 0005 adds `public_key` (D-18), absent at the "before" snapshot.
  const credentialResult = await db.execute<{
    id: string;
    type: string;
    encrypted_value: string;
    key_version: number;
    created_at: string;
    updated_at: string;
  }>(sql`
    select id, type, encrypted_value, key_version, created_at, updated_at
    from credentials where id = ${ids.credentialId}
  `);
  const credential = credentialResult.rows[0];
  // Raw SQL restricted to the columns present in the *previous* migration snapshot (0001):
  // `schema.servers` (the current code's schema module) includes `host_fingerprint_captured_at`
  // and `pending_fingerprint_seen_at`, the two columns migration 0002 adds — they do not exist yet
  // when this function is called for the "before" snapshot, so selecting through the ORM's full
  // column list would fail exactly like the login_attempts case above.
  const serverResult = await db.execute<{
    id: string;
    name: string;
    host: string;
    ssh_port: number;
    ssh_user: string;
    credential_id: string;
    status: string;
    host_fingerprint: string | null;
    pending_fingerprint: string | null;
    hostname: string | null;
    os_distribution: string | null;
    os_version: string | null;
    arch: string | null;
    cpu_cores: number | null;
    ram_mb: number | null;
    disk_total_mb: number | null;
    disk_used_mb: number | null;
    uptime_seconds: number | null;
    docker_installed: boolean | null;
    docker_version: string | null;
    last_seen_at: string | null;
    last_error_code: string | null;
    created_at: string;
    updated_at: string;
  }>(sql`
    select id, name, host, ssh_port, ssh_user, credential_id, status, host_fingerprint,
      pending_fingerprint, hostname, os_distribution, os_version, arch, cpu_cores, ram_mb,
      disk_total_mb, disk_used_mb, uptime_seconds, docker_installed, docker_version, last_seen_at,
      last_error_code, created_at, updated_at
    from servers where id = ${ids.serverId}
  `);
  const server = serverResult.rows[0];
  const [activityEvent] = await db
    .select()
    .from(schema.activityEvents)
    .where(eq(schema.activityEvents.id, ids.activityEventId));

  return { user, account, session, verification, setupToken, loginAttempt, credential, server, activityEvent };
}

let fixture: PostgresFixture | undefined;

afterEach(async () => {
  await fixture?.stop();
  fixture = undefined;

  // noodara-tdd skill §5: no stray container labelled noodara.test=true survives a run.
  const { getContainerRuntimeClient } = await import('testcontainers');
  const client = await getContainerRuntimeClient();
  const containers = await client.container.list();
  const stray = containers.filter((container) => container.Labels['noodara.test'] === 'true');
  expect(stray).toHaveLength(0);
});

describe('migrations applied from scratch (QA-06)', () => {
  it('readJournal returns the ordered list of migration tags', () => {
    expect(readJournal()).toEqual([
      '0000_shiny_franklin_storm',
      '0001_silky_lethal_legion',
      '0002_phase2_fingerprint_timestamps',
      '0003_phase3_discovery_snapshots',
      '0004_phase9_user_preferences',
      '0005_phase11_deploy_engine',
      '0006_phase13_deployment_steps',
      '0007_phase14_git_host_key_codes',
      '0008_phase14_service_git_host_key',
      '0009_phase14_enqueue_failed_code',
    ]);
  });

  it('applies every migration to an empty database and creates every table and enum', async () => {
    fixture = await startPostgres({ migrate: false });
    const journal = readJournal();
    const lastTag = journal[journal.length - 1] ?? null;

    await applyMigrationsUpTo(fixture.db, lastTag);

    const tableNames = await listTableNames(fixture.db);
    for (const expected of EXPECTED_TABLES) {
      expect(tableNames).toContain(expected);
    }

    const enumNames = await listEnumNames(fixture.db);
    for (const expected of EXPECTED_ENUMS) {
      expect(enumNames).toContain(expected);
    }
  });

  it('applyMigrationsUpTo(db, null) applies nothing', async () => {
    fixture = await startPostgres({ migrate: false });

    await applyMigrationsUpTo(fixture.db, null);

    const tableNames = await listTableNames(fixture.db);
    expect(tableNames).toHaveLength(0);
  });

  it('records exactly one bookkeeping row per journal entry after a full apply', async () => {
    fixture = await startPostgres({ migrate: false });
    const journal = readJournal();

    await applyMigrationsUpTo(fixture.db, journal[journal.length - 1] ?? null);

    const rowCount = await countBookkeepingRows(fixture.db);
    expect(rowCount).toBe(journal.length);
  });

  it('applying all migrations twice via the production runMigrations path is a no-op the second time', async () => {
    fixture = await startPostgres({ migrate: false });

    await runMigrations(fixture.db);
    const firstRunCount = await countBookkeepingRows(fixture.db);

    await runMigrations(fixture.db);
    const secondRunCount = await countBookkeepingRows(fixture.db);

    expect(secondRunCount).toBe(firstRunCount);
  });
});

describe('migration 0005 defensive guards (T-11-15)', () => {
  it('re-executing every 0005 statement on a fully migrated database is a no-op', async () => {
    fixture = await startPostgres();
    const contents = readFileSync(
      `${MIGRATIONS_FOLDER}/0005_phase11_deploy_engine.sql`,
      'utf8',
    );

    for (const statement of contents.split('--> statement-breakpoint')) {
      await fixture.db.execute(sql.raw(statement));
    }

    const tableNames = await listTableNames(fixture.db);
    expect(tableNames).toEqual(expect.arrayContaining(['services', 'deployments']));
    const enumValues = await fixture.db.execute<{ value: string }>(
      sql`select unnest(enum_range(null::credential_type))::text as value`,
    );
    expect(enumValues.rows.map((row) => row.value)).toEqual([
      'ssh_private_key',
      'ssh_password',
      'git_deploy_key',
      'git_https_token',
      'registry_password',
    ]);
  });
});

describe('migration 0006 step boundaries (13-03 H1, H3)', () => {
  it('adds three nullable timestamptz columns and re-executing it is a no-op', async () => {
    fixture = await startPostgres();
    const contents = readFileSync(`${MIGRATIONS_FOLDER}/0006_phase13_deployment_steps.sql`, 'utf8');
    for (const statement of contents.split('--> statement-breakpoint')) {
      await fixture.db.execute(sql.raw(statement));
    }

    const columns = await fixture.db.execute<{ column_name: string; data_type: string; is_nullable: string }>(sql`
      select column_name, data_type, is_nullable from information_schema.columns
      where table_name = 'deployments'
        and column_name in ('building_started_at', 'deploying_started_at', 'verifying_started_at')
      order by column_name
    `);
    expect(columns.rows).toEqual([
      { column_name: 'building_started_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
      { column_name: 'deploying_started_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
      { column_name: 'verifying_started_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
    ]);
  });
});

describe('phase-3 schema objects (D-06, D-09, D-10)', () => {
  it('servers.docker_compose_version exists as nullable text', async () => {
    fixture = await startPostgres();

    const result = await fixture.db.execute<{
      data_type: string;
      is_nullable: string;
    }>(sql`
      select data_type, is_nullable from information_schema.columns
      where table_name = 'servers' and column_name = 'docker_compose_version'
    `);

    expect(result.rows[0]?.data_type).toBe('text');
    expect(result.rows[0]?.is_nullable).toBe('YES');
  });

  it('creates the two servers unique indexes and the discovery_snapshots index', async () => {
    fixture = await startPostgres();

    const result = await fixture.db.execute<{ indexname: string }>(sql`
      select indexname from pg_indexes where schemaname = 'public'
    `);
    const indexNames = result.rows.map((row) => row.indexname);

    expect(indexNames).toContain('servers_name_lower_unique_idx');
    expect(indexNames).toContain('servers_host_port_unique_idx');
    expect(indexNames).toContain('discovery_snapshots_server_id_collected_at_idx');
  });

  async function insertCredential(db: Database): Promise<string> {
    const [credential] = await db
      .insert(schema.credentials)
      .values({ type: 'ssh_password', encryptedValue: 'v1:nonce:cipher:tag', keyVersion: 1 })
      .returning();
    return assertDefined(credential, 'credential').id;
  }

  function assertDefined<T>(value: T | undefined, what: string): T {
    if (value === undefined) throw new Error(`expected ${what} insert to return a row`);
    return value;
  }

  it('rejects a second server whose name differs only by case (D-10)', async () => {
    fixture = await startPostgres();
    const credentialId = await insertCredential(fixture.db);

    await fixture.db
      .insert(schema.servers)
      .values({ name: 'srv-1', host: '10.0.0.1', sshUser: 'root', credentialId });

    await expect(
      fixture.db
        .insert(schema.servers)
        .values({ name: 'SRV-1', host: '10.0.0.2', sshUser: 'root', credentialId }),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('rejects two servers sharing (host, ssh_port) with different names (D-10)', async () => {
    fixture = await startPostgres();
    const credentialId = await insertCredential(fixture.db);

    await fixture.db
      .insert(schema.servers)
      .values({ name: 'srv-a', host: '10.0.0.5', sshPort: 22, sshUser: 'root', credentialId });

    await expect(
      fixture.db
        .insert(schema.servers)
        .values({ name: 'srv-b', host: '10.0.0.5', sshPort: 22, sshUser: 'root', credentialId }),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('accepts two servers with the same host but different ssh_port', async () => {
    fixture = await startPostgres();
    const credentialId = await insertCredential(fixture.db);

    await fixture.db
      .insert(schema.servers)
      .values({ name: 'srv-c', host: '10.0.0.9', sshPort: 22, sshUser: 'root', credentialId });

    const inserted = await fixture.db
      .insert(schema.servers)
      .values({ name: 'srv-d', host: '10.0.0.9', sshPort: 2222, sshUser: 'root', credentialId })
      .returning();

    expect(inserted).toHaveLength(1);
  });

  it('cascades discovery_snapshots deletion when the owning server is deleted (D-08)', async () => {
    fixture = await startPostgres();
    const credentialId = await insertCredential(fixture.db);
    const [server] = await fixture.db
      .insert(schema.servers)
      .values({ name: 'srv-cascade', host: '10.0.0.20', sshUser: 'root', credentialId })
      .returning();
    const serverId = assertDefined(server, 'server').id;

    await seedDiscoverySnapshot(fixture.db, serverId);

    await fixture.db.delete(schema.servers).where(eq(schema.servers.id, serverId));

    const remaining = await fixture.db.execute<{ count: number }>(
      sql`select count(*)::int as count from discovery_snapshots where server_id = ${serverId}`,
    );
    expect(remaining.rows[0]?.count).toBe(0);
  });

  it('round-trips a DiscoverySnapshot-shaped payload through jsonb, and accepts a NULL error_code', async () => {
    fixture = await startPostgres();
    const credentialId = await insertCredential(fixture.db);
    const [server] = await fixture.db
      .insert(schema.servers)
      .values({ name: 'srv-payload', host: '10.0.0.30', sshUser: 'root', credentialId })
      .returning();
    const serverId = assertDefined(server, 'server').id;

    const payload = {
      facts: {
        hostname: 'roundtrip-host',
        osDistribution: 'ubuntu',
        osVersion: '22.04',
        arch: 'aarch64',
        cpuCores: 2,
        ramMb: 4096,
        diskTotalMb: 51200,
        diskUsedMb: 10240,
        uptimeSeconds: 120,
        dockerInstalled: false,
        dockerVersion: null,
        dockerComposeVersion: null,
      },
      checks: [{ id: 'hostname', status: 'pass', detail: 'roundtrip-host', durationMs: 5 }],
      warnings: [],
    };

    const snapshotId = uuidv7();
    await fixture.db.execute(sql`
      insert into discovery_snapshots (id, server_id, collected_at, outcome, error_code, payload)
      values (${snapshotId}, ${serverId}, now(), 'ok', null, ${JSON.stringify(payload)}::jsonb)
    `);

    const result = await fixture.db.execute<{ payload: unknown; error_code: string | null }>(
      sql`select payload, error_code from discovery_snapshots where id = ${snapshotId}`,
    );

    expect(result.rows[0]?.payload).toEqual(payload);
    expect(result.rows[0]?.error_code).toBeNull();
  });
});

describe('phase-9 schema objects (D-16)', () => {
  it('users.preferences exists as jsonb NOT NULL DEFAULT \'{}\'::jsonb', async () => {
    fixture = await startPostgres();

    const result = await fixture.db.execute<{
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(sql`
      select data_type, is_nullable, column_default from information_schema.columns
      where table_name = 'users' and column_name = 'preferences'
    `);

    expect(result.rows[0]?.data_type).toBe('jsonb');
    expect(result.rows[0]?.is_nullable).toBe('NO');
    expect(result.rows[0]?.column_default).toContain("'{}'::jsonb");
  });

  it('a users row inserted without preferences reads back {}', async () => {
    fixture = await startPostgres();

    const [inserted] = await fixture.db
      .insert(schema.users)
      .values({ name: 'No Prefs', email: 'no-prefs@example.com' })
      .returning();

    expect(inserted?.preferences).toEqual({});
  });

  it('round-trips a preferences jsonb object unchanged', async () => {
    fixture = await startPostgres();

    const value = { theme: 'dark', reduceMotion: 'on', density: 'compact' };
    const [inserted] = await fixture.db
      .insert(schema.users)
      .values({ name: 'Prefs User', email: 'prefs-user@example.com', preferences: value })
      .returning();

    expect(inserted?.preferences).toEqual(value);
  });
});

describe('migrations applied from the previous snapshot (QA-06, PITFALLS.md #10)', () => {
  it('preserves representative data across an upgrade from the previous snapshot to the latest migration', async () => {
    fixture = await startPostgres({ migrate: false });
    const journal = readJournal();
    // Generic over the journal length (01-CONTEXT.md: "en esta fase el snapshot anterior es la
    // migracion inicial") — with a single entry today, the "previous snapshot" is that same
    // entry; once migration 3/4/5 exist this automatically shifts to journal[journal.length - 2]
    // with no edit to this test required.
    const previousTag = journal[journal.length - 2] ?? journal[0] ?? null;
    const previousTagIndex = previousTag === null ? -1 : journal.indexOf(previousTag);

    await applyMigrationsUpTo(fixture.db, previousTag);
    const ids = await seedRepresentativeData(fixture.db);
    const before = await fetchSeededSnapshot(fixture.db, ids);
    const bookkeepingRowsBeforeUpgrade = await countBookkeepingRows(fixture.db);

    // The upgrade step: apply whatever comes after `previousTag` via the exact production path
    // (never a second, divergent code path). This is a genuine, non-trivial upgrade whenever
    // `previousTag` is not already the latest journal entry (true as soon as a second migration
    // exists, as Plan 01-13's own migration 0001 now proves) — the earlier phase-1 comment here
    // describing a "no-op re-run" only ever held true while exactly one migration existed.
    await runMigrations(fixture.db);

    const after = await fetchSeededSnapshot(fixture.db, ids);
    const bookkeepingRowsAfterUpgrade = await countBookkeepingRows(fixture.db);

    expect(after).toEqual(before);
    // Generic over the journal length: before the upgrade, exactly the migrations up to and
    // including `previousTag` are recorded; after it, every migration in the journal is.
    expect(bookkeepingRowsBeforeUpgrade).toBe(previousTagIndex + 1);
    expect(bookkeepingRowsAfterUpgrade).toBe(journal.length);

    // The FK from servers.credential_id to the seeded credential still resolves, and status is
    // unchanged, after the upgrade step (Task 2 acceptance criteria).
    expect(after.server?.credential_id).toBe(ids.credentialId);
    expect(after.server?.status).toBe(before.server?.status);

    // Plan 01-13's migration 0001 adds `lockout_count` to a table that already had rows: a
    // pre-existing row (seeded before this migration ran) must backfill to the column's default
    // (0), not NULL — proven directly against the real column, since `before`/`after` above never
    // reference it (it does not exist yet at the "before" snapshot).
    const lockoutCountResult = await fixture.db.execute<{ lockout_count: number }>(
      sql`select lockout_count from login_attempts where id = ${ids.loginAttemptId}`,
    );
    expect(lockoutCountResult.rows[0]?.lockout_count).toBe(0);

    // Migration 0002 adds `host_fingerprint_captured_at`/`pending_fingerprint_seen_at` to
    // `servers`, a table that already has a row (seeded before this migration ran) with a
    // non-null `host_fingerprint`. Both new columns are nullable with no default, so the ADD
    // COLUMN backfill must be NULL, not a spurious value (Task 2 acceptance criteria).
    const fingerprintTimestampsResult = await fixture.db.execute<{
      host_fingerprint_captured_at: string | null;
      pending_fingerprint_seen_at: string | null;
    }>(
      sql`select host_fingerprint_captured_at, pending_fingerprint_seen_at from servers where id = ${ids.serverId}`,
    );
    expect(fingerprintTimestampsResult.rows[0]?.host_fingerprint_captured_at).toBeNull();
    expect(fingerprintTimestampsResult.rows[0]?.pending_fingerprint_seen_at).toBeNull();

    // Migration 0003 adds `docker_compose_version` (D-09) to `servers`, a table that already has a
    // row (seeded before this migration ran). The column is nullable with no default, so the ADD
    // COLUMN backfill must be NULL, not a spurious value.
    const dockerComposeVersionResult = await fixture.db.execute<{
      docker_compose_version: string | null;
    }>(sql`select docker_compose_version from servers where id = ${ids.serverId}`);
    expect(dockerComposeVersionResult.rows[0]?.docker_compose_version).toBeNull();

    // Round-trip a real Date through the new column to prove `withTimezone: true` actually landed
    // as `timestamptz` (which normalizes to UTC and preserves the instant) rather than a naive
    // `timestamp` (which would silently drop or misinterpret the offset).
    const knownInstant = new Date('2026-05-01T12:34:56.000Z');
    await fixture.db.execute(
      sql`update servers set pending_fingerprint_seen_at = ${knownInstant.toISOString()}::timestamptz where id = ${ids.serverId}`,
    );
    const roundTripResult = await fixture.db.execute<{ pending_fingerprint_seen_at: string }>(
      sql`select pending_fingerprint_seen_at from servers where id = ${ids.serverId}`,
    );
    const storedValue = roundTripResult.rows[0]?.pending_fingerprint_seen_at;
    expect(storedValue).toBeDefined();
    expect(new Date(storedValue as string).getTime()).toBe(knownInstant.getTime());

    // Migration 0004 adds `preferences` (D-16) to `users`, a table that already has a row
    // (seeded before this migration ran). The column is NOT NULL with a jsonb default, so the
    // ADD COLUMN backfill must produce {}, not NULL.
    const preferencesResult = await fixture.db.execute<{ preferences: unknown }>(
      sql`select preferences from users where id = ${ids.userId}`,
    );
    expect(preferencesResult.rows[0]?.preferences).toEqual({});

    // Migration 0005 adds `docker_buildkit_available` (D-03 fact) to `servers` and `public_key`
    // (D-18) to `credentials`, both tables with a pre-existing row. Both columns are nullable with
    // no default, so the backfill must be NULL; widening `credential_type` (D-16) must leave the
    // pre-existing ssh_private_key row untouched.
    const buildkitResult = await fixture.db.execute<{ docker_buildkit_available: boolean | null }>(
      sql`select docker_buildkit_available from servers where id = ${ids.serverId}`,
    );
    expect(buildkitResult.rows[0]?.docker_buildkit_available).toBeNull();
    const credentialAfterResult = await fixture.db.execute<{ type: string; public_key: string | null }>(
      sql`select type, public_key from credentials where id = ${ids.credentialId}`,
    );
    expect(credentialAfterResult.rows[0]?.public_key).toBeNull();
    expect(credentialAfterResult.rows[0]?.type).toBe(before.credential?.type);
    expect(credentialAfterResult.rows[0]?.type).toBe('ssh_password');
  });
});
