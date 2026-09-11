import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { Database } from '../../../apps/control-plane/src/db/client.js';
import { runMigrations } from '../../../apps/control-plane/src/db/migrate.js';
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
