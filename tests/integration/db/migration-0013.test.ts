import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql, TransactionRollbackError } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NON_TERMINAL_DEPLOYMENT_STATUSES } from '@noodara/domain/deployment';
import { WEBHOOK_DELIVERY_OUTCOMES } from '@noodara/domain';
import type { Database } from '../../../apps/control-plane/src/db/client.js';
import { MIGRATIONS_FOLDER, runMigrations } from '../../../apps/control-plane/src/db/migrate.js';
import { noopServerEventPublisher } from '../../../apps/control-plane/src/events/server-event-publisher.js';
import { applyMigrationsUpTo, readJournal } from '../helpers/migrations.js';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';

// 16-06: migration 0013 only adds the v0.3 columns and the webhook_deliveries table. 0011 (enum
// values) and 0012 (one-active index) belong to 16-02 and stay byte-for-byte as shipped.
//
// H1 bound (documented here and in deployments.ts): on 10 000 deployment rows the forward run of
// 0013 and its in-transaction "down" (rollback) each finish within MIGRATION_BOUND_MS, and neither
// rewrites the deployments or services heap (relfilenode unchanged): every deployments column is
// nullable without a default, the services defaults are constants (metadata-only since PG 11).

const V020_TAG = '0010_phase14_workspace_unavailable_code';
const MIGRATION_0011 = '0011_phase16_v03_enum_values';
const MIGRATION_0012 = '0012_phase16_active_deployment_index';
const MIGRATION_0013 = '0013_phase16_v03_columns';
const SHIPPED_HASHES: Record<string, string> = {
  [MIGRATION_0011]: '54259ff265db24a44cdb5152452886dfe0737963e93ec083b8324770f418482a',
  [MIGRATION_0012]: 'd2e9a992da40b565756cb1b61553c3bacc2fc3b4746c85cae859cc4d5b21b819',
};
const WEBHOOK_SECRET_TYPE = 'webhook_secret';
const WEBHOOK_SECRET_ADD_VALUE = `ALTER TYPE "public"."credential_type" ADD VALUE IF NOT EXISTS '${WEBHOOK_SECRET_TYPE}';`;
const MIGRATION_BOUND_MS = 10_000;
const BULK_ROWS = 10_000;
const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const FINGERPRINT = 'f'.repeat(64);

const DEPLOYMENT_COLUMNS: Record<string, string> = {
  image_ref: 'text',
  rollback_of_deployment_id: 'uuid',
  webhook_delivery_id: 'uuid',
  idempotency_key: 'text',
  request_fingerprint: 'text',
  runtime_config: 'jsonb',
  healthcheck_started_at: 'timestamp with time zone',
  rollback_started_at: 'timestamp with time zone',
};

const SERVICE_COLUMNS: Record<string, { type: string; nullable: boolean; default: string | null }> = {
  healthcheck: { type: 'jsonb', nullable: true, default: null },
  auto_rollback: { type: 'boolean', nullable: false, default: 'true' },
  image_retention: { type: 'integer', nullable: false, default: '3' },
  webhook_hook_id: { type: 'text', nullable: true, default: null },
  webhook_secret_credential_id: { type: 'uuid', nullable: true, default: null },
  pending_trigger_delivery_id: { type: 'text', nullable: true, default: null },
  pending_trigger_sha: { type: 'text', nullable: true, default: null },
  pending_trigger_at: { type: 'timestamp with time zone', nullable: true, default: null },
};

const WEBHOOK_DELIVERY_COLUMNS = [
  'id',
  'service_id',
  'delivery_id',
  'event',
  'outcome',
  'pushed_sha',
  'deployment_id',
  'received_at',
];

interface ColumnInfo {
  column_name: string;
  data_type: string;
  is_nullable: 'YES' | 'NO';
  column_default: string | null;
}

async function columnsOf(db: Database, table: string): Promise<Map<string, ColumnInfo>> {
  const result = await db.execute<ColumnInfo>(sql`
    select column_name, data_type, is_nullable, column_default
    from information_schema.columns where table_schema = 'public' and table_name = ${table}
  `);
  return new Map(result.rows.map((row) => [row.column_name, row]));
}

function statementsOf(tag: string): string[] {
  return readFileSync(`${MIGRATIONS_FOLDER}/${tag}.sql`, 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) =>
      statement
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((statement) => statement.length > 0);
}

function sqlErrorOf(error: unknown): { code?: string; constraint?: string } {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string') {
      return {
        code: candidate.code,
        constraint: typeof candidate.constraint === 'string' ? candidate.constraint : undefined,
      };
    }
    current = candidate.cause;
  }
  return {};
}

async function expectSqlError(
  promise: Promise<unknown>,
  code: string,
  constraint?: string,
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  const details = sqlErrorOf(caught);
  expect(details.code).toBe(code);
  if (constraint !== undefined) expect(details.constraint).toBe(constraint);
}

async function insertCredential(db: Database): Promise<string> {
  const id = uuidv7();
  await db.execute(sql`
    insert into credentials (id, type, encrypted_value, key_version)
    values (${id}, 'ssh_password', 'v1:nonce:ciphertext:tag', 1)
  `);
  return id;
}

// A counter, not random bits: (host, ssh_port) is unique and random ports collide across seeds.
let sshPortSeed = 20_000;
function nextSshPort(): number {
  sshPortSeed += 1;
  return sshPortSeed;
}

async function seedService(db: Database): Promise<string> {
  const credentialId = await insertCredential(db);
  const serverId = uuidv7();
  const projectId = uuidv7();
  const environmentId = uuidv7();
  const serviceId = uuidv7();
  const suffix = serviceId.slice(-8);
  await db.execute(sql`
    insert into servers (id, name, host, ssh_port, ssh_user, credential_id)
    values (${serverId}, ${`srv-${suffix}`}, '10.3.0.1', ${nextSshPort()},
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
  extra: { idempotencyKey?: string; fingerprint?: string } = {},
): Promise<string> {
  const id = uuidv7();
  await db.execute(sql`
    insert into deployments (id, service_id, status, source, idempotency_key, request_fingerprint)
    values (${id}, ${serviceId}, ${status}::deployment_status, '{"type":"image"}'::jsonb,
      ${extra.idempotencyKey ?? null}, ${extra.fingerprint ?? null})
  `);
  return id;
}

async function insertV020Deployment(db: Database, serviceId: string, status: string): Promise<void> {
  await db.execute(sql`
    insert into deployments (id, service_id, status, source)
    values (${uuidv7()}, ${serviceId}, ${status}::deployment_status, '{"type":"image"}'::jsonb)
  `);
}

async function insertDelivery(
  db: Database,
  serviceId: string,
  deliveryId: string,
  outcome: string,
  deploymentId: string | null = null,
): Promise<string> {
  const id = uuidv7();
  await db.execute(sql`
    insert into webhook_deliveries (id, service_id, delivery_id, event, outcome, pushed_sha, deployment_id)
    values (${id}, ${serviceId}, ${deliveryId}, 'push', ${outcome}, ${SHA}, ${deploymentId})
  `);
  return id;
}

async function enableWebhook(db: Database, serviceId: string, hookId: string): Promise<string> {
  const credentialId = await insertCredential(db);
  await db.execute(sql`
    update services set webhook_hook_id = ${hookId}, webhook_secret_credential_id = ${credentialId}
    where id = ${serviceId}
  `);
  return credentialId;
}

type ServiceServicesModule = typeof import('../../../apps/control-plane/src/services/service-services.js');
type ProjectServicesModule = typeof import('../../../apps/control-plane/src/services/project-services.js');

/** The service modules read env.ts at import, so they load only after a valid env is set. */
async function loadDeletePaths(
  connectionString: string,
): Promise<{ deleteService: ServiceServicesModule['deleteService']; deleteProject: ProjectServicesModule['deleteProject'] }> {
  process.env.NOODARA_MASTER_KEY ??= randomBytes(32).toString('base64');
  process.env.BETTER_AUTH_SECRET ??= `migration-0013-${randomUUID()}-${randomUUID()}`;
  process.env.DATABASE_URL ??= connectionString;
  process.env.REDIS_URL ??= 'redis://localhost:6379';
  process.env.NOODARA_PUBLIC_URL ??= 'http://localhost:3000';
  const serviceModule: ServiceServicesModule = await import('../../../apps/control-plane/src/services/service-services.js');
  const projectModule: ProjectServicesModule = await import('../../../apps/control-plane/src/services/project-services.js');
  return { deleteService: serviceModule.deleteService, deleteProject: projectModule.deleteProject };
}

async function serviceScope(db: Database, serviceId: string): Promise<{ projectId: string; name: string }> {
  const result = await db.execute<{ projectId: string; name: string }>(
    sql`select project_id as "projectId", name from services where id = ${serviceId}`,
  );
  const row = result.rows[0];
  if (!row) throw new Error(`service ${serviceId} not seeded`);
  return row;
}

async function countRows(db: Database, query: ReturnType<typeof sql>): Promise<number> {
  const result = await db.execute<{ count: number }>(query);
  return result.rows[0]?.count ?? -1;
}

async function relfilenode(db: Database, table: string): Promise<string> {
  const result = await db.execute<{ node: string }>(
    sql`select relfilenode::text as node from pg_class where oid = ${`public.${table}`}::regclass`,
  );
  return result.rows[0]?.node ?? '';
}

async function expectNoStrayContainers(): Promise<void> {
  const { getContainerRuntimeClient } = await import('testcontainers');
  const client = await getContainerRuntimeClient();
  const containers = await client.container.list();
  expect(containers.filter((c) => c.Labels['noodara.test'] === 'true')).toHaveLength(0);
}

function hookId(): string {
  return createHash('sha256').update(uuidv7()).digest('base64url').slice(0, 32);
}

describe('migration 0013 files (16-06 A1, H2)', () => {
  it('the journal lists 0011, 0012 then 0013 consecutively', () => {
    const journal = readJournal();
    const start = journal.indexOf(MIGRATION_0011);
    expect(start).toBeGreaterThan(-1);
    expect(journal.slice(start, start + 3)).toEqual([MIGRATION_0011, MIGRATION_0012, MIGRATION_0013]);
  });

  it.each(Object.entries(SHIPPED_HASHES))('%s is byte-for-byte the 16-02 file', (tag, hash) => {
    const contents = readFileSync(`${MIGRATIONS_FOLDER}/${tag}.sql`, 'utf8');
    expect(createHash('sha256').update(contents).digest('hex')).toBe(hash);
  });

  it('0013 adds credential_type webhook_secret with IF NOT EXISTS and never uses it (A1, H2)', () => {
    const statements = statementsOf(MIGRATION_0013);
    const addValue = statements.filter((statement) => /\bADD\s+VALUE\b/i.test(statement));
    expect(addValue).toEqual([WEBHOOK_SECRET_ADD_VALUE]);
    const others = statements.filter((statement) => statement !== WEBHOOK_SECRET_ADD_VALUE);
    expect(others.filter((statement) => statement.includes(`'${WEBHOOK_SECRET_TYPE}'`))).toEqual([]);
  });

  it('0013 otherwise only adds columns, tables, constraints and indexes (no type, enum or drop)', () => {
    const statements = statementsOf(MIGRATION_0013).filter((statement) => statement !== WEBHOOK_SECRET_ADD_VALUE);
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      const body = statement
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .replace(/\bON (?:DELETE|UPDATE)\b/gi, '');
      expect(body).not.toMatch(/\bALTER\s+TYPE\b|\bCREATE\s+TYPE\b|\bADD\s+VALUE\b|\bDROP\b|\bRENAME\b/i);
      expect(body).not.toMatch(/\bALTER\s+COLUMN\b|\bUPDATE\b|\bDELETE\b/i);
      expect(body).toMatch(
        /^(?:ALTER TABLE "\w+" ADD (?:COLUMN IF NOT EXISTS|CONSTRAINT)|DO \$\$|CREATE TABLE IF NOT EXISTS|CREATE (?:UNIQUE )?INDEX IF NOT EXISTS)/,
      );
    }
  });

  it('the fixture runs the same PostgreSQL image as production (docker-compose.yml)', () => {
    const compose = readFileSync(new URL('../../../docker-compose.yml', import.meta.url), 'utf8');
    const helper = readFileSync(new URL('../helpers/postgres.ts', import.meta.url), 'utf8');
    const productionImage = /image:\s*(postgres:[\w.-]+)/.exec(compose)?.[1];
    expect(productionImage).toBeDefined();
    expect(helper).toContain(`new PostgreSqlContainer('${productionImage ?? ''}')`);
  });
});

describe('migration 0013 on a fresh database (16-06 A2-A4, H3)', () => {
  let fixture: PostgresFixture | undefined;
  const db = (): Database => {
    if (fixture === undefined) throw new Error('fixture not started');
    return fixture.db;
  };
  const connectionString = (): string => {
    if (fixture === undefined) throw new Error('fixture not started');
    return fixture.connectionString;
  };

  beforeAll(async () => {
    fixture = await startPostgres();
  });

  afterAll(async () => {
    await fixture?.stop();
    fixture = undefined;
    await expectNoStrayContainers();
  });

  it('runs on the PostgreSQL major the production image pins', async () => {
    const compose = readFileSync(new URL('../../../docker-compose.yml', import.meta.url), 'utf8');
    const major = /image:\s*postgres:(\d+)/.exec(compose)?.[1];
    const result = await db().execute<{ server_version: string }>(sql`show server_version`);
    expect(result.rows[0]?.server_version.split('.')[0]).toBe(major);
  });

  it('deployments gains the nullable v0.3 traceability columns (A2)', async () => {
    const columns = await columnsOf(db(), 'deployments');
    for (const [name, type] of Object.entries(DEPLOYMENT_COLUMNS)) {
      expect(columns.get(name), name).toMatchObject({ data_type: type, is_nullable: 'YES', column_default: null });
    }
  });

  it('a new deployment row leaves every v0.3 column null', async () => {
    const serviceId = await seedService(db());
    const id = await insertDeployment(db(), serviceId, 'QUEUED');
    const result = await db().execute<Record<string, unknown>>(
      sql`select * from deployments where id = ${id}`,
    );
    for (const name of Object.keys(DEPLOYMENT_COLUMNS)) {
      expect(result.rows[0]?.[name], name).toBeNull();
    }
  });

  it('rollback_of_deployment_id is set null when its target is deleted', async () => {
    const serviceId = await seedService(db());
    const target = await insertDeployment(db(), serviceId, 'SUCCESS');
    const rollback = await insertDeployment(db(), serviceId, 'QUEUED');
    await db().execute(
      sql`update deployments set rollback_of_deployment_id = ${target} where id = ${rollback}`,
    );

    await db().execute(sql`delete from deployments where id = ${target}`);

    const result = await db().execute<{ ref: string | null }>(
      sql`select rollback_of_deployment_id as ref from deployments where id = ${rollback}`,
    );
    expect(result.rows[0]?.ref).toBeNull();
    await expectSqlError(
      db().execute(sql`update deployments set rollback_of_deployment_id = ${uuidv7()} where id = ${rollback}`),
      '23503',
    );
  });

  it('webhook_delivery_id references webhook_deliveries and is set null when the delivery goes', async () => {
    const serviceId = await seedService(db());
    const deploymentId = await insertDeployment(db(), serviceId, 'QUEUED');
    const deliveryRow = await insertDelivery(db(), serviceId, uuidv7(), 'deployed', deploymentId);
    await db().execute(
      sql`update deployments set webhook_delivery_id = ${deliveryRow} where id = ${deploymentId}`,
    );

    await db().execute(sql`delete from webhook_deliveries where id = ${deliveryRow}`);

    const result = await db().execute<{ ref: string | null }>(
      sql`select webhook_delivery_id as ref from deployments where id = ${deploymentId}`,
    );
    expect(result.rows[0]?.ref).toBeNull();
  });

  it('idempotency_key is unique per service when set, and travels with its fingerprint', async () => {
    const serviceId = await seedService(db());
    const otherService = await seedService(db());
    await insertDeployment(db(), serviceId, 'SUCCESS', { idempotencyKey: 'k-1', fingerprint: FINGERPRINT });
    await insertDeployment(db(), serviceId, 'FAILED');
    await insertDeployment(db(), serviceId, 'CANCELLED');
    await insertDeployment(db(), otherService, 'SUCCESS', { idempotencyKey: 'k-1', fingerprint: FINGERPRINT });

    await expectSqlError(
      insertDeployment(db(), serviceId, 'FAILED', { idempotencyKey: 'k-1', fingerprint: FINGERPRINT }),
      '23505',
      'deployments_service_idempotency_key_unique_idx',
    );
    await expectSqlError(
      insertDeployment(db(), serviceId, 'FAILED', { idempotencyKey: 'k-2' }),
      '23514',
      'deployments_idempotency_pair_check',
    );
    await expectSqlError(
      insertDeployment(db(), serviceId, 'FAILED', { fingerprint: FINGERPRINT }),
      '23514',
      'deployments_idempotency_pair_check',
    );
    await expectSqlError(
      insertDeployment(db(), serviceId, 'FAILED', { idempotencyKey: 'k-3', fingerprint: 'not-hex' }),
      '23514',
      'deployments_idempotency_pair_check',
    );
  });

  it('runtime_config must be a JSON object when set', async () => {
    const serviceId = await seedService(db());
    const id = await insertDeployment(db(), serviceId, 'SUCCESS');
    await db().execute(
      sql`update deployments set runtime_config = '{"imageRef":"nginx:1.27"}'::jsonb where id = ${id}`,
    );
    await expectSqlError(
      db().execute(sql`update deployments set runtime_config = '[]'::jsonb where id = ${id}`),
      '23514',
      'deployments_runtime_config_object_check',
    );
  });

  it('services gains healthcheck, auto_rollback, image_retention, webhook and pending-trigger columns (A3)', async () => {
    const columns = await columnsOf(db(), 'services');
    for (const [name, expected] of Object.entries(SERVICE_COLUMNS)) {
      expect(columns.get(name), name).toMatchObject({
        data_type: expected.type,
        is_nullable: expected.nullable ? 'YES' : 'NO',
        column_default: expected.default,
      });
    }
  });

  it('a new service defaults to the container healthcheck, auto-rollback on and retention 3', async () => {
    const serviceId = await seedService(db());
    const result = await db().execute<{
      healthcheck: unknown;
      auto_rollback: boolean;
      image_retention: number;
      webhook_hook_id: string | null;
    }>(
      sql`select healthcheck, auto_rollback, image_retention, webhook_hook_id from services where id = ${serviceId}`,
    );
    expect(result.rows[0]).toEqual({
      healthcheck: null,
      auto_rollback: true,
      image_retention: 3,
      webhook_hook_id: null,
    });
  });

  it.each([0, 11])('rejects image_retention %d (1..10)', async (value) => {
    const serviceId = await seedService(db());
    await expectSqlError(
      db().execute(sql`update services set image_retention = ${value} where id = ${serviceId}`),
      '23514',
      'services_image_retention_range_check',
    );
  });

  it('rejects a healthcheck that is not a JSON object', async () => {
    const serviceId = await seedService(db());
    await expectSqlError(
      db().execute(sql`update services set healthcheck = '"http"'::jsonb where id = ${serviceId}`),
      '23514',
      'services_healthcheck_object_check',
    );
  });

  it('the webhook hook id is unique and random-shaped', async () => {
    const first = await seedService(db());
    const second = await seedService(db());
    const shared = hookId();
    await enableWebhook(db(), first, shared);

    await expectSqlError(enableWebhook(db(), second, shared), '23505', 'services_webhook_hook_id_unique_idx');
    await expectSqlError(enableWebhook(db(), second, 'short'), '23514', 'services_webhook_hook_id_shape_check');
  });

  it('credential_type gains webhook_secret for the encrypted HMAC secret (A1)', async () => {
    const result = await db().execute<{ value: string }>(
      sql`select unnest(enum_range(null::credential_type))::text as value`,
    );
    expect(result.rows.map((row) => row.value)).toContain(WEBHOOK_SECRET_TYPE);
  });

  it('deleting the webhook secret credential never deletes the service: the FK sets null (A3)', async () => {
    const serviceId = await seedService(db());
    const shared = hookId();
    const credentialId = await enableWebhook(db(), serviceId, shared);

    await db().execute(sql`delete from credentials where id = ${credentialId}`);

    const result = await db().execute<{ hook: string | null; credential: string | null }>(sql`
      select webhook_hook_id as hook, webhook_secret_credential_id as credential
      from services where id = ${serviceId}
    `);
    expect(result.rows).toEqual([{ hook: shared, credential: null }]);
  });

  it('a secret credential without a hook id is rejected (A3)', async () => {
    const serviceId = await seedService(db());
    const credentialId = await insertCredential(db());
    await expectSqlError(
      db().execute(sql`update services set webhook_secret_credential_id = ${credentialId} where id = ${serviceId}`),
      '23514',
      'services_webhook_pair_check',
    );
  });

  it('deleteService removes the webhook secret credential with the service (A3)', async () => {
    const serviceId = await seedService(db());
    const credentialId = await enableWebhook(db(), serviceId, hookId());
    const scope = await serviceScope(db(), serviceId);
    const { deleteService } = await loadDeletePaths(connectionString());

    const result = await deleteService(
      { db: db(), now: () => new Date(), events: noopServerEventPublisher, panelPorts: [] },
      { actor: { type: 'system' }, projectId: scope.projectId, serviceId, confirmName: scope.name },
    );

    expect(result).toEqual({ ok: true, serviceId });
    expect(await countRows(db(), sql`select count(*)::int as count from services where id = ${serviceId}`)).toBe(0);
    expect(
      await countRows(db(), sql`select count(*)::int as count from credentials where id = ${credentialId}`),
    ).toBe(0);
  });

  it('deleteProject removes the webhook secret credential of every service it deletes (A3)', async () => {
    const serviceId = await seedService(db());
    const credentialId = await enableWebhook(db(), serviceId, hookId());
    const scope = await serviceScope(db(), serviceId);
    await db().execute(sql`update projects set archived_at = now() where id = ${scope.projectId}`);
    const project = await db().execute<{ name: string }>(sql`select name from projects where id = ${scope.projectId}`);
    const { deleteProject } = await loadDeletePaths(connectionString());

    const result = await deleteProject(
      { db: db(), now: () => new Date() },
      { actor: { type: 'system' }, projectId: scope.projectId, confirmName: project.rows[0]?.name ?? '' },
    );

    expect(result).toEqual({ ok: true, projectId: scope.projectId });
    expect(await countRows(db(), sql`select count(*)::int as count from services where id = ${serviceId}`)).toBe(0);
    expect(
      await countRows(db(), sql`select count(*)::int as count from credentials where id = ${credentialId}`),
    ).toBe(0);
  });

  it('pending-trigger columns are set together with a 40-hex SHA, or not at all', async () => {
    const serviceId = await seedService(db());
    await db().execute(sql`
      update services set pending_trigger_delivery_id = ${uuidv7()}, pending_trigger_sha = ${SHA},
        pending_trigger_at = now() where id = ${serviceId}
    `);
    await expectSqlError(
      db().execute(sql`update services set pending_trigger_sha = null where id = ${serviceId}`),
      '23514',
      'services_pending_trigger_check',
    );
    await expectSqlError(
      db().execute(sql`update services set pending_trigger_sha = 'HEAD' where id = ${serviceId}`),
      '23514',
      'services_pending_trigger_check',
    );
    await db().execute(sql`
      update services set pending_trigger_delivery_id = null, pending_trigger_sha = null,
        pending_trigger_at = null where id = ${serviceId}
    `);
  });

  it('webhook_deliveries holds exactly the traceability columns, no payload or signature (A4)', async () => {
    const columns = await columnsOf(db(), 'webhook_deliveries');
    expect([...columns.keys()].sort()).toEqual([...WEBHOOK_DELIVERY_COLUMNS].sort());
    expect(columns.get('received_at')).toMatchObject({ is_nullable: 'NO', data_type: 'timestamp with time zone' });
    expect(columns.get('pushed_sha')?.is_nullable).toBe('YES');
    expect(columns.get('deployment_id')?.is_nullable).toBe('YES');
  });

  it.each(WEBHOOK_DELIVERY_OUTCOMES)('accepts the domain outcome %s', async (outcome) => {
    const serviceId = await seedService(db());
    await insertDelivery(db(), serviceId, uuidv7(), outcome);
  });

  it('rejects an outcome outside the domain vocabulary and a malformed pushed SHA', async () => {
    const serviceId = await seedService(db());
    await expectSqlError(
      insertDelivery(db(), serviceId, uuidv7(), 'duplicate'),
      '23514',
      'webhook_deliveries_outcome_check',
    );
    await expectSqlError(
      db().execute(sql`
        insert into webhook_deliveries (id, service_id, delivery_id, event, outcome, pushed_sha)
        values (${uuidv7()}, ${serviceId}, ${uuidv7()}, 'push', 'deployed', 'main')
      `),
      '23514',
      'webhook_deliveries_pushed_sha_check',
    );
  });

  it('a delivery id is unique per hook, received_at defaults to now and the deployment FK sets null', async () => {
    const serviceId = await seedService(db());
    const otherService = await seedService(db());
    const deliveryId = uuidv7();
    const deploymentId = await insertDeployment(db(), serviceId, 'SUCCESS');
    const row = await insertDelivery(db(), serviceId, deliveryId, 'deployed', deploymentId);
    await insertDelivery(db(), otherService, deliveryId, 'deployed');

    await expectSqlError(
      insertDelivery(db(), serviceId, deliveryId, 'coalesced'),
      '23505',
      'webhook_deliveries_service_delivery_unique_idx',
    );

    await db().execute(sql`delete from deployments where id = ${deploymentId}`);
    const result = await db().execute<{ deployment_id: string | null; fresh: boolean }>(sql`
      select deployment_id, received_at > now() - interval '1 minute' as fresh
      from webhook_deliveries where id = ${row}
    `);
    expect(result.rows[0]).toEqual({ deployment_id: null, fresh: true });
  });

  it('deleting a service cascades to its webhook deliveries', async () => {
    const serviceId = await seedService(db());
    await insertDelivery(db(), serviceId, uuidv7(), 'ping');
    await db().execute(sql`delete from services where id = ${serviceId}`);
    expect(
      await countRows(
        db(),
        sql`select count(*)::int as count from webhook_deliveries where service_id = ${serviceId}`,
      ),
    ).toBe(0);
  });

  it('a concurrent double insert of one (service, idempotency_key) yields exactly one row (H3)', async () => {
    const serviceId = await seedService(db());
    const results = await Promise.allSettled([
      insertDeployment(db(), serviceId, 'SUCCESS', { idempotencyKey: 'race', fingerprint: FINGERPRINT }),
      insertDeployment(db(), serviceId, 'FAILED', { idempotencyKey: 'race', fingerprint: FINGERPRINT }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(sqlErrorOf(rejected?.reason)).toEqual({
      code: '23505',
      constraint: 'deployments_service_idempotency_key_unique_idx',
    });
    expect(
      await countRows(
        db(),
        sql`select count(*)::int as count from deployments where service_id = ${serviceId} and idempotency_key = 'race'`,
      ),
    ).toBe(1);
  });

  it('a concurrent double claim of one webhook hook id yields exactly one owner (H3)', async () => {
    const first = await seedService(db());
    const second = await seedService(db());
    const shared = hookId();
    const results = await Promise.allSettled([
      enableWebhook(db(), first, shared),
      enableWebhook(db(), second, shared),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(sqlErrorOf(rejected?.reason)).toEqual({
      code: '23505',
      constraint: 'services_webhook_hook_id_unique_idx',
    });
    expect(
      await countRows(
        db(),
        sql`select count(*)::int as count from services where webhook_hook_id = ${shared}`,
      ),
    ).toBe(1);
  });

  it('re-executing every 0013 statement on a fully migrated database is a no-op (H1)', async () => {
    const before = await Promise.all(
      ['deployments', 'services', 'webhook_deliveries'].map(async (t) => [...(await columnsOf(db(), t)).keys()].sort()),
    );
    for (const statement of statementsOf(MIGRATION_0013)) {
      await db().execute(sql.raw(statement));
    }
    const after = await Promise.all(
      ['deployments', 'services', 'webhook_deliveries'].map(async (t) => [...(await columnsOf(db(), t)).keys()].sort()),
    );
    expect(after).toEqual(before);
  });
});

describe('migrations 0011-0013 upgrading the v0.2.0 schema (16-06 A5, H2)', () => {
  let fixture: PostgresFixture | undefined;

  afterAll(async () => {
    await fixture?.stop();
    fixture = undefined;
    await expectNoStrayContainers();
  });

  it('applies over v0.2.0 data in one migrator run, keeps every row and still enforces one active deployment', async () => {
    fixture = await startPostgres({ migrate: false });
    const { db } = fixture;
    await applyMigrationsUpTo(db, V020_TAG);

    const finishedService = await seedService(db);
    const activeService = await seedService(db);
    await db.execute(sql`
      insert into deployments (id, service_id, status, source, commit_sha, error_code)
      values (${uuidv7()}, ${finishedService}, 'FAILED', '{"type":"git"}'::jsonb, ${OTHER_SHA}, 'BUILD_FAILED')
    `);
    await insertV020Deployment(db, finishedService, 'SUCCESS');
    await insertV020Deployment(db, activeService, 'DEPLOYING');
    const servicesBefore = await db.execute(sql`select * from services order by id`);
    const deploymentsBefore = await db.execute(sql`select * from deployments order by id`);

    // The production path: 0011, 0012 and 0013 in drizzle's single transaction (H2: no statement
    // uses a value 0011 adds in that same transaction, or this run fails with 55P04).
    await runMigrations(db);

    const servicesAfter = await db.execute<Record<string, unknown>>(sql`select * from services order by id`);
    const deploymentsAfter = await db.execute<Record<string, unknown>>(sql`select * from deployments order by id`);
    expect(servicesAfter.rows).toEqual(servicesBefore.rows.map((row) => expect.objectContaining(row)));
    expect(deploymentsAfter.rows).toEqual(deploymentsBefore.rows.map((row) => expect.objectContaining(row)));
    for (const row of deploymentsAfter.rows) {
      for (const name of Object.keys(DEPLOYMENT_COLUMNS)) expect(row[name], name).toBeNull();
    }
    for (const row of servicesAfter.rows) {
      expect(row).toMatchObject({ healthcheck: null, auto_rollback: true, image_retention: 3, webhook_hook_id: null });
    }

    for (const status of NON_TERMINAL_DEPLOYMENT_STATUSES) {
      await expectSqlError(
        insertDeployment(db, activeService, status),
        '23505',
        'deployments_service_active_unique_idx',
      );
    }
    await insertDeployment(db, finishedService, 'HEALTHCHECK');
  });
});

describe('migration 0013 on 10k deployment rows (16-06 H1)', () => {
  let fixture: PostgresFixture | undefined;

  // Container boot is not part of the H1 bound: started here so the test budget covers only the
  // seeding and the timed migration runs, and afterAll always holds the handle it must stop.
  beforeAll(async () => {
    fixture = await startPostgres({ migrate: false });
  });

  afterAll(async () => {
    await fixture?.stop();
    fixture = undefined;
    await expectNoStrayContainers();
  });

  it(
    'goes down (rolled back) and forward within the documented bound without rewriting either table',
    async () => {
      if (fixture === undefined) throw new Error('postgres fixture did not start');
      const { db } = fixture;
      await applyMigrationsUpTo(db, MIGRATION_0012);
      const serviceId = await seedService(db);
      await db.execute(sql`
        insert into deployments (id, service_id, status, source, created_at)
        select gen_random_uuid(), ${serviceId}, 'SUCCESS', '{"type":"image"}'::jsonb,
          now() - make_interval(secs => g)
        from generate_series(1, ${BULK_ROWS}) as g
      `);
      const deploymentsNode = await relfilenode(db, 'deployments');
      const servicesNode = await relfilenode(db, 'services');
      const before = [...(await columnsOf(db, 'deployments')).keys()].sort();

      // Down: the whole of 0013 inside a transaction that is rolled back leaves the 0012 schema.
      const downStart = performance.now();
      await db
        .transaction(async (tx) => {
          for (const statement of statementsOf(MIGRATION_0013)) {
            await tx.execute(sql.raw(statement));
          }
          tx.rollback();
        })
        .catch((error: unknown) => {
          if (!(error instanceof TransactionRollbackError)) throw error;
        });
      expect(performance.now() - downStart).toBeLessThan(MIGRATION_BOUND_MS);
      expect([...(await columnsOf(db, 'deployments')).keys()].sort()).toEqual(before);

      const forwardStart = performance.now();
      await runMigrations(db);
      expect(performance.now() - forwardStart).toBeLessThan(MIGRATION_BOUND_MS);

      expect(await relfilenode(db, 'deployments')).toBe(deploymentsNode);
      expect(await relfilenode(db, 'services')).toBe(servicesNode);
      expect(
        await countRows(
          db,
          sql`select count(*)::int as count from deployments where image_ref is null and idempotency_key is null`,
        ),
      ).toBe(BULK_ROWS);
    },
    60_000,
  );
});
