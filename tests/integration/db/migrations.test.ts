import { eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { Database } from '../../../apps/control-plane/src/db/client.js';
import { runMigrations } from '../../../apps/control-plane/src/db/migrate.js';
import * as schema from '../../../apps/control-plane/src/db/schema/index.js';
import {
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
  const [loginAttempt] = await db
    .select()
    .from(schema.loginAttempts)
    .where(eq(schema.loginAttempts.id, ids.loginAttemptId));
  const [credential] = await db
    .select()
    .from(schema.credentials)
    .where(eq(schema.credentials.id, ids.credentialId));
  const [server] = await db
    .select()
    .from(schema.servers)
    .where(eq(schema.servers.id, ids.serverId));
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
    expect(readJournal()).toEqual(['0000_shiny_franklin_storm']);
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

describe('migrations applied from the previous snapshot (QA-06, PITFALLS.md #10)', () => {
  it('preserves representative data across an upgrade from the previous snapshot to the latest migration', async () => {
    fixture = await startPostgres({ migrate: false });
    const journal = readJournal();
    // Generic over the journal length (01-CONTEXT.md: "en esta fase el snapshot anterior es la
    // migracion inicial") — with a single entry today, the "previous snapshot" is that same
    // entry; once migration 3/4/5 exist this automatically shifts to journal[journal.length - 2]
    // with no edit to this test required.
    const previousTag = journal[journal.length - 2] ?? journal[0] ?? null;

    await applyMigrationsUpTo(fixture.db, previousTag);
    const ids = await seedRepresentativeData(fixture.db);
    const before = await fetchSeededSnapshot(fixture.db, ids);
    const bookkeepingRowsBeforeUpgrade = await countBookkeepingRows(fixture.db);

    // The upgrade step: apply whatever comes after `previousTag` via the exact production path
    // (never a second, divergent code path) — a full no-op re-run when previousTag is already
    // the latest journal entry, exactly like an in-place upgrade with no pending migrations.
    await runMigrations(fixture.db);

    const after = await fetchSeededSnapshot(fixture.db, ids);
    const bookkeepingRowsAfterUpgrade = await countBookkeepingRows(fixture.db);

    expect(after).toEqual(before);
    expect(bookkeepingRowsAfterUpgrade).toBe(bookkeepingRowsBeforeUpgrade);

    // The FK from servers.credential_id to the seeded credential still resolves, and status is
    // unchanged, after the upgrade step (Task 2 acceptance criteria).
    expect(after.server?.credentialId).toBe(ids.credentialId);
    expect(after.server?.status).toBe(before.server?.status);
  });
});
