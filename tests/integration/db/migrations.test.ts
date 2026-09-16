import { eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterEach, describe, expect, it } from 'vitest';
import type { Database } from '../../../apps/control-plane/src/db/client.js';
import { runMigrations } from '../../../apps/control-plane/src/db/migrate.js';
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
];

const EXPECTED_ENUMS = [
  'server_status',
  'server_error_code',
  'setup_token_purpose',
  'credential_type',
  'login_attempt_scope',
  'activity_actor_type',
  'activity_outcome',
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
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, ids.userId));
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
  const [credential] = await db
    .select()
    .from(schema.credentials)
    .where(eq(schema.credentials.id, ids.credentialId));
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
  });
});
