import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEPLOYMENT_ERROR_CODES,
  DEPLOYMENT_LOG_PHASES,
  DEPLOYMENT_STATUSES,
  DEPLOYMENT_TRIGGERS,
  NON_TERMINAL_DEPLOYMENT_STATUSES,
  TERMINAL_DEPLOYMENT_STATUSES,
} from '@noodara/domain/deployment';
import type { Database } from '../../../apps/control-plane/src/db/client.js';
import { MIGRATIONS_FOLDER, runMigrations } from '../../../apps/control-plane/src/db/migrate.js';
import { applyMigrationsUpTo, readJournal } from '../helpers/migrations.js';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';

// 16-02 A8: migration 0011 adds the v0.3 enum values (ADD VALUE IF NOT EXISTS); 0012 recreates the
// one-active partial unique index. drizzle runs every pending migration in ONE transaction and
// Postgres rejects a new enum literal in that transaction (55P04), so the predicate cannot list
// HEALTHCHECK/ROLLING_BACK: 0011 sorts them BEFORE 'SUCCESS' and 0012 indexes `status < 'SUCCESS'`.

const V020_TAG = '0010_phase14_workspace_unavailable_code';
const MIGRATION_0011 = '0011_phase16_v03_enum_values';
const MIGRATION_0012 = '0012_phase16_active_deployment_index';
const ACTIVE_INDEX = 'deployments_service_active_unique_idx';

const ENUM_TUPLES = [
  ['deployment_status', DEPLOYMENT_STATUSES],
  ['deployment_trigger', DEPLOYMENT_TRIGGERS],
  ['deployment_log_phase', DEPLOYMENT_LOG_PHASES],
  ['deployment_error_code', DEPLOYMENT_ERROR_CODES],
] as const;

async function enumValues(db: Database, typeName: string): Promise<string[]> {
  const result = await db.execute<{ value: string }>(
    sql.raw(`select unnest(enum_range(null::${typeName}))::text as value`),
  );
  return result.rows.map((row) => row.value);
}

async function seedService(db: Database): Promise<string> {
  const credentialId = uuidv7();
  const serverId = uuidv7();
  const projectId = uuidv7();
  const environmentId = uuidv7();
  const serviceId = uuidv7();
  const suffix = serviceId.slice(-8);
  await db.execute(sql`
    insert into credentials (id, type, encrypted_value, key_version)
    values (${credentialId}, 'ssh_password', 'ciphertext', 1)
  `);
  await db.execute(sql`
    insert into servers (id, name, host, ssh_port, ssh_user, credential_id)
    values (${serverId}, ${`srv-${suffix}`}, '10.2.0.1', ${20_000 + Number.parseInt(suffix.slice(-3), 16)},
      'root', ${credentialId})
  `);
  await db.execute(
    sql`insert into projects (id, name, slug) values (${projectId}, ${`p-${suffix}`}, ${`p-${suffix}`})`,
  );
  await db.execute(
    sql`insert into environments (id, project_id, name) values (${environmentId}, ${projectId}, 'production')`,
  );
  await db.execute(sql`
    insert into services (id, project_id, environment_id, server_id, name, source_type, image_ref, internal_port)
    values (${serviceId}, ${projectId}, ${environmentId}, ${serverId}, ${`svc-${suffix}`}, 'image',
      'nginx:1.27-alpine', 80)
  `);
  return serviceId;
}

async function insertDeployment(
  db: Database,
  serviceId: string,
  status: string,
  errorCode: string | null = null,
): Promise<string> {
  const id = uuidv7();
  await db.execute(sql`
    insert into deployments (id, service_id, status, source, error_code)
    values (${id}, ${serviceId}, ${status}::deployment_status, '{"type":"image"}'::jsonb,
      ${errorCode}::deployment_error_code)
  `);
  return id;
}

function sqlCodeOf(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth += 1) {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string') return candidate.code;
    current = candidate.cause;
  }
  return undefined;
}

async function expectUniqueViolation(promise: Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(sqlCodeOf(caught)).toBe('23505');
}

async function snapshotRows(db: Database): Promise<unknown[]> {
  const deployments = await db.execute(sql`select * from deployments order by id`);
  const chunks = await db.execute(sql`select * from deployment_log_chunks order by id`);
  return [deployments.rows, chunks.rows];
}

async function expectNoStrayContainers(): Promise<void> {
  const { getContainerRuntimeClient } = await import('testcontainers');
  const client = await getContainerRuntimeClient();
  const containers = await client.container.list();
  expect(containers.filter((c) => c.Labels['noodara.test'] === 'true')).toHaveLength(0);
}

describe('migrations 0011/0012 on a fresh database (16-02 A8)', () => {
  let fixture: PostgresFixture | undefined;
  const db = (): Database => {
    if (fixture === undefined) throw new Error('fixture not started');
    return fixture.db;
  };

  beforeAll(async () => {
    fixture = await startPostgres();
  });

  afterAll(async () => {
    await fixture?.stop();
    fixture = undefined;
    await expectNoStrayContainers();
  });

  it('the journal ends with 0011 then 0012', () => {
    expect(readJournal().slice(-2)).toEqual([MIGRATION_0011, MIGRATION_0012]);
  });

  it.each(ENUM_TUPLES)('%s holds exactly the domain tuple values', async (typeName, domain) => {
    expect([...(await enumValues(db(), typeName))].sort()).toEqual([...domain].sort());
  });

  it("the enum sort order puts every non-terminal status before 'SUCCESS' and every terminal one at or after it", async () => {
    const result = await db().execute<{ value: string; active: boolean }>(sql`
      select v::text as value, v < 'SUCCESS'::deployment_status as active
      from unnest(enum_range(null::deployment_status)) as v
    `);
    const active = result.rows.filter((row) => row.active).map((row) => row.value);
    const inactive = result.rows.filter((row) => !row.active).map((row) => row.value);

    expect(active.sort()).toEqual([...NON_TERMINAL_DEPLOYMENT_STATUSES].sort());
    expect(inactive.sort()).toEqual([...TERMINAL_DEPLOYMENT_STATUSES].sort());
  });

  it('the one-active index is predicated on the non-terminal partition', async () => {
    const result = await db().execute<{ indexdef: string }>(
      sql`select indexdef from pg_indexes where schemaname = 'public' and indexname = ${ACTIVE_INDEX}`,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.indexdef).toMatch(/UNIQUE INDEX .* WHERE \(status < 'SUCCESS'::deployment_status\)/);
  });

  it.each(NON_TERMINAL_DEPLOYMENT_STATUSES)(
    'rejects a second deployment in %s while one is QUEUED (23505)',
    async (status) => {
      const serviceId = await seedService(db());
      await insertDeployment(db(), serviceId, 'QUEUED');

      await expectUniqueViolation(insertDeployment(db(), serviceId, status));
    },
  );

  it.each(TERMINAL_DEPLOYMENT_STATUSES)(
    'accepts a new QUEUED deployment once the previous one reached %s',
    async (terminal) => {
      const serviceId = await seedService(db());
      const firstId = await insertDeployment(db(), serviceId, 'HEALTHCHECK');
      await db().execute(
        sql`update deployments set status = ${terminal}::deployment_status where id = ${firstId}`,
      );

      await insertDeployment(db(), serviceId, 'QUEUED');

      const count = await db().execute<{ count: number }>(
        sql`select count(*)::int as count from deployments where service_id = ${serviceId}`,
      );
      expect(count.rows[0]?.count).toBe(2);
    },
  );

  it.each([MIGRATION_0011, MIGRATION_0012])(
    're-executing every %s statement on a fully migrated database is a no-op',
    async (tag) => {
      const before = await Promise.all(ENUM_TUPLES.map(([name]) => enumValues(db(), name)));
      const contents = readFileSync(`${MIGRATIONS_FOLDER}/${tag}.sql`, 'utf8');
      for (const statement of contents.split('--> statement-breakpoint')) {
        await db().execute(sql.raw(statement));
      }

      const after = await Promise.all(ENUM_TUPLES.map(([name]) => enumValues(db(), name)));
      expect(after).toEqual(before);
      const index = await db().execute(
        sql`select 1 from pg_indexes where schemaname = 'public' and indexname = ${ACTIVE_INDEX}`,
      );
      expect(index.rows).toHaveLength(1);
    },
  );
});

describe('migrations 0011/0012 upgrading the v0.2.0 schema (16-02 A8)', () => {
  let fixture: PostgresFixture | undefined;

  afterAll(async () => {
    await fixture?.stop();
    fixture = undefined;
    await expectNoStrayContainers();
  });

  it('applies over v0.2.0 data in one migrator run, leaves every row unchanged and enforces the new index', async () => {
    fixture = await startPostgres({ migrate: false });
    const { db } = fixture;
    await applyMigrationsUpTo(db, V020_TAG);

    const finishedService = await seedService(db);
    const activeService = await seedService(db);
    const succeeded = await insertDeployment(db, finishedService, 'SUCCESS');
    await insertDeployment(db, finishedService, 'FAILED', 'BUILD_FAILED');
    await insertDeployment(db, finishedService, 'CANCELLED');
    await insertDeployment(db, activeService, 'DEPLOYING');
    await db.execute(sql`
      insert into deployment_log_chunks (id, deployment_id, phase, seq, content, byte_length)
      values (${uuidv7()}, ${succeeded}, 'deploy', 0, 'started', 7)
    `);
    const before = await snapshotRows(db);

    // The production path: 0011 and 0012 run together in drizzle's single transaction.
    await runMigrations(db);

    expect(await snapshotRows(db)).toEqual(before);
    for (const [typeName, domain] of ENUM_TUPLES) {
      expect([...(await enumValues(db, typeName))].sort()).toEqual([...domain].sort());
    }
    await expectUniqueViolation(insertDeployment(db, activeService, 'HEALTHCHECK'));
    await expectUniqueViolation(insertDeployment(db, activeService, 'ROLLING_BACK'));
    await insertDeployment(db, activeService, 'ROLLED_BACK', 'HEALTHCHECK_FAILED');
    await insertDeployment(db, finishedService, 'ROLLING_BACK');
  });
});
