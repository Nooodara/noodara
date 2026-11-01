import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DOMAINS_HOSTNAME_UNIQUE_INDEX,
  ENVIRONMENT_VARIABLES_OWNER_KEY_UNIQUE_INDEX,
  SECRETS_OWNER_NAME_UNIQUE_INDEX,
  mapUniqueViolation,
} from '@noodara/domain/api-contract';
import { V04_DEPLOYMENT_ERROR_CODES } from '@noodara/domain/deployment';
import type { Database } from '../../../apps/control-plane/src/db/client.js';
import { MIGRATIONS_FOLDER, runMigrations } from '../../../apps/control-plane/src/db/migrate.js';
import * as schema from '../../../apps/control-plane/src/db/schema/index.js';
import { applyMigrationsUpTo, readJournal } from '../helpers/migrations.js';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';

// 21-06: 0014 only grows enums (three deployment error codes, four new types); 0015 creates the
// domains, secrets and environment_variables tables and the servers proxy columns. The database
// enforces ownership (composite FKs), scope shape (CHECK) and the unique tuples the 21-05 mapper
// turns into 409s, so a caller that bypasses every service still cannot cross projects.

const V030_TAG = '0013_phase16_v03_columns';
const MIGRATION_0014 = '0014_phase21_v04_enums';
const MIGRATION_0015 = '0015_phase21_v04_tables';
const CIPHERTEXT = 'v1:bm9uY2U=:Y2lwaGVy:dGFn';

interface PgErrorShape {
  readonly code?: string;
  readonly constraint?: string;
}

function pgErrorOf(error: unknown): PgErrorShape {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth += 1) {
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

async function caught(action: Promise<unknown>): Promise<unknown> {
  try {
    await action;
  } catch (error) {
    return error;
  }
  return undefined;
}

async function expectPgError(action: Promise<unknown>, code: string, constraint?: string): Promise<void> {
  const error = await caught(action);
  expect(error, `expected SQLSTATE ${code}`).toBeDefined();
  const pg = pgErrorOf(error);
  expect(pg.code).toBe(code);
  if (constraint !== undefined) expect(pg.constraint).toBe(constraint);
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

async function expectNoStrayContainers(): Promise<void> {
  const { getContainerRuntimeClient } = await import('testcontainers');
  const client = await getContainerRuntimeClient();
  const containers = await client.container.list();
  expect(containers.filter((container) => container.Labels['noodara.test'] === 'true')).toHaveLength(0);
}

let portSeed = 30_000;

interface Scope {
  readonly projectId: string;
  readonly environmentId: string;
  readonly serviceId: string;
  readonly serverId: string;
}

async function seedScope(db: Database): Promise<Scope> {
  const credentialId = uuidv7();
  const serverId = uuidv7();
  const projectId = uuidv7();
  const environmentId = uuidv7();
  const serviceId = uuidv7();
  const suffix = serviceId.slice(-12);
  portSeed += 1;
  await db.execute(sql`
    insert into credentials (id, type, encrypted_value, key_version)
    values (${credentialId}, 'ssh_password', ${CIPHERTEXT}, 1)
  `);
  await db.execute(sql`
    insert into servers (id, name, host, ssh_port, ssh_user, credential_id)
    values (${serverId}, ${`srv-${suffix}`}, '10.3.0.1', ${portSeed}, 'root', ${credentialId})
  `);
  await db.execute(sql`insert into projects (id, name, slug) values (${projectId}, ${`p-${suffix}`}, ${`p-${suffix}`})`);
  await db.execute(
    sql`insert into environments (id, project_id, name) values (${environmentId}, ${projectId}, 'production')`,
  );
  await db.execute(sql`
    insert into services (id, project_id, environment_id, server_id, name, source_type, image_ref, internal_port)
    values (${serviceId}, ${projectId}, ${environmentId}, ${serverId}, ${`svc-${suffix}`}, 'image', 'nginx:1.27-alpine', 80)
  `);
  return { projectId, environmentId, serviceId, serverId };
}

function insertDomain(db: Database, projectId: string, serviceId: string, hostname: string): Promise<unknown> {
  return db.execute(sql`
    insert into domains (id, project_id, service_id, hostname)
    values (${uuidv7()}, ${projectId}, ${serviceId}, ${hostname})
  `);
}

interface OwnerRef {
  readonly scope: 'project' | 'environment' | 'service';
  readonly projectId: string;
  readonly environmentId?: string | null;
  readonly serviceId?: string | null;
}

function insertVariable(db: Database, owner: OwnerRef, key: string, value = 'v'): Promise<unknown> {
  return db.execute(sql`
    insert into environment_variables (id, scope, project_id, environment_id, service_id, key, value)
    values (${uuidv7()}, ${owner.scope}, ${owner.projectId}, ${owner.environmentId ?? null},
      ${owner.serviceId ?? null}, ${key}, ${value})
  `);
}

function insertSecret(db: Database, owner: OwnerRef, name: string, version = 1): Promise<unknown> {
  return db.execute(sql`
    insert into secrets (id, scope, project_id, environment_id, service_id, name, encrypted_value,
      key_version, version, hint)
    values (${uuidv7()}, ${owner.scope}, ${owner.projectId}, ${owner.environmentId ?? null},
      ${owner.serviceId ?? null}, ${name}, ${CIPHERTEXT}, 1, ${version}, '…a1b2')
  `);
}

async function columnNames(db: Database, table: string): Promise<string[]> {
  const result = await db.execute<{ column_name: string }>(sql`
    select column_name from information_schema.columns
    where table_schema = 'public' and table_name = ${table}
  `);
  return result.rows.map((row) => row.column_name).sort();
}

async function count(db: Database, table: string, column: string, value: string): Promise<number> {
  const result = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from ${sql.identifier(table)} where ${sql.identifier(column)} = ${value}`,
  );
  return result.rows[0]?.n ?? -1;
}

describe('migrations 0014/0015 files (21-06 A1, H1, H3)', () => {
  it('the journal holds 0013, 0014 then 0015 consecutively', () => {
    const journal = readJournal();
    const at = journal.indexOf(V030_TAG);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(journal.slice(at, at + 3)).toEqual([V030_TAG, MIGRATION_0014, MIGRATION_0015]);
  });

  it('0014 only adds enum values and creates the four v0.4 enums', () => {
    const statements = statementsOf(MIGRATION_0014);
    for (const statement of statements) {
      expect(statement).toMatch(/^(ALTER TYPE "public"\."deployment_error_code" ADD VALUE IF NOT EXISTS|DO \$\$ BEGIN\s+CREATE TYPE)/);
    }
    const added = statements.flatMap((statement) =>
      [...statement.matchAll(/ADD VALUE IF NOT EXISTS '([^']+)'/g)].map((match) => match[1]),
    );
    expect(added).toEqual([...V04_DEPLOYMENT_ERROR_CODES]);
    const created = statements.flatMap((statement) =>
      [...statement.matchAll(/CREATE TYPE "public"\."([a-z_]+)"/g)].map((match) => match[1]),
    );
    expect(created.sort()).toEqual(['domain_cert_status', 'domain_dns_status', 'env_scope', 'proxy_status']);
  });

  it('0015 creates no type, adds no enum value and drops nothing', () => {
    for (const statement of statementsOf(MIGRATION_0015)) {
      expect(statement).not.toMatch(/CREATE TYPE|ADD VALUE|\bDROP\b/i);
    }
  });

  it('0015 and the Drizzle schema create the unique indexes the 21-05 mapper names (H1)', () => {
    const contents = readFileSync(`${MIGRATIONS_FOLDER}/${MIGRATION_0015}.sql`, 'utf8');
    const expected = [
      [schema.domains, DOMAINS_HOSTNAME_UNIQUE_INDEX],
      [schema.environmentVariables, ENVIRONMENT_VARIABLES_OWNER_KEY_UNIQUE_INDEX],
      [schema.secrets, SECRETS_OWNER_NAME_UNIQUE_INDEX],
    ] as const;
    for (const [table, name] of expected) {
      expect(contents).toContain(`CREATE UNIQUE INDEX IF NOT EXISTS "${name}"`);
      const config = getTableConfig(table);
      const index = config.indexes.find((candidate) => candidate.config.name === name);
      expect(index?.config.unique, name).toBe(true);
    }
  });
});

describe('v0.4 schema on a fresh database (21-06 A1, A2, H1, H3)', () => {
  let fixture: PostgresFixture | undefined;

  function db(): Database {
    if (fixture === undefined) throw new Error('postgres fixture not started');
    return fixture.db;
  }

  beforeAll(async () => {
    fixture = await startPostgres();
  });

  afterAll(async () => {
    await fixture?.stop();
    fixture = undefined;
    await expectNoStrayContainers();
  });

  it('domains, secrets and environment_variables have exactly the planned columns', async () => {
    expect(await columnNames(db(), 'domains')).toEqual(
      [
        'id',
        'project_id',
        'service_id',
        'hostname',
        'https_redirect',
        'cert_status',
        'cert_not_after',
        'cert_error_code',
        'dns_status',
        'dns_checked_at',
        'apply_status',
        'created_at',
        'updated_at',
      ].sort(),
    );
    expect(await columnNames(db(), 'secrets')).toEqual(
      [
        'id',
        'scope',
        'project_id',
        'environment_id',
        'service_id',
        'name',
        'encrypted_value',
        'key_version',
        'version',
        'hint',
        'created_at',
        'updated_at',
      ].sort(),
    );
    expect(await columnNames(db(), 'environment_variables')).toEqual(
      ['id', 'scope', 'project_id', 'environment_id', 'service_id', 'key', 'value', 'created_at', 'updated_at'].sort(),
    );
    const servers = await columnNames(db(), 'servers');
    expect(servers).toEqual(
      expect.arrayContaining(['proxy_status', 'proxy_error_code', 'proxy_acme_email', 'proxy_installed_at']),
    );
  });

  it('the secrets table has no plaintext column (H1)', async () => {
    const columns = await columnNames(db(), 'secrets');
    expect(columns.filter((name) => /^(value|plaintext|secret|secret_value|raw_value)$/.test(name))).toEqual([]);
    expect(columns).toContain('encrypted_value');
  });

  it('a new domain defaults to redirect on, cert NONE, no DNS check and apply PENDING', async () => {
    const scope = await seedScope(db());
    const inserted = await db()
      .insert(schema.domains)
      .values({ projectId: scope.projectId, serviceId: scope.serviceId, hostname: 'app.example.com' })
      .returning();
    expect(inserted[0]).toMatchObject({
      hostname: 'app.example.com',
      httpsRedirect: true,
      certStatus: 'NONE',
      certNotAfter: null,
      certErrorCode: null,
      dnsStatus: null,
      dnsCheckedAt: null,
      applyStatus: 'PENDING',
    });
  });

  it('a server defaults to proxy NOT_INSTALLED with no error, email or install time', async () => {
    const scope = await seedScope(db());
    const rows = await db().execute<Record<string, unknown>>(
      sql`select proxy_status, proxy_error_code, proxy_acme_email, proxy_installed_at from servers where id = ${scope.serverId}`,
    );
    expect(rows.rows[0]).toEqual({
      proxy_status: 'NOT_INSTALLED',
      proxy_error_code: null,
      proxy_acme_email: null,
      proxy_installed_at: null,
    });
  });

  it('rejects a proxy error code outside the server proxy vocabulary and an over-long ACME email', async () => {
    const scope = await seedScope(db());
    await expectPgError(
      db().execute(sql`update servers set proxy_error_code = 'PROXY_ROUTE_FAILED' where id = ${scope.serverId}`),
      '23514',
    );
    await expectPgError(
      db().execute(sql`update servers set proxy_acme_email = ${`${'a'.repeat(250)}@x.io`} where id = ${scope.serverId}`),
      '23514',
    );
    await db().execute(
      sql`update servers set proxy_status = 'FAILED', proxy_error_code = 'PROXY_PORT_IN_USE' where id = ${scope.serverId}`,
    );
  });

  it('a hostname is globally unique and stored lowercased; a second insert fails with 23505 (H3)', async () => {
    const first = await seedScope(db());
    const second = await seedScope(db());
    await insertDomain(db(), first.projectId, first.serviceId, 'shop.example.com');
    const error = await caught(insertDomain(db(), second.projectId, second.serviceId, 'shop.example.com'));
    expect(pgErrorOf(error)).toEqual({ code: '23505', constraint: DOMAINS_HOSTNAME_UNIQUE_INDEX });
    expect(mapUniqueViolation(error)).toBe('DOMAIN_ALREADY_ASSIGNED');
    await expectPgError(insertDomain(db(), second.projectId, second.serviceId, 'Upper.Example.com'), '23514');
    await expectPgError(insertDomain(db(), second.projectId, second.serviceId, `${'a'.repeat(250)}.com`), '23514');
  });

  it('rejects a cert error code outside the failure causes', async () => {
    const scope = await seedScope(db());
    await expectPgError(
      db().execute(sql`
        insert into domains (id, project_id, service_id, hostname, cert_error_code)
        values (${uuidv7()}, ${scope.projectId}, ${scope.serviceId}, 'bad-cause.example.com', 'BUILD_FAILED')
      `),
      '23514',
    );
  });

  it('a domain of another project is impossible by FK (A2)', async () => {
    const own = await seedScope(db());
    const other = await seedScope(db());
    await expectPgError(
      insertDomain(db(), own.projectId, other.serviceId, 'cross.example.com'),
      '23503',
      'domains_service_project_fk',
    );
  });

  it('a variable or secret of another project is impossible by FK (A2)', async () => {
    const own = await seedScope(db());
    const other = await seedScope(db());
    await expectPgError(
      insertVariable(db(), { scope: 'environment', projectId: own.projectId, environmentId: other.environmentId }, 'K'),
      '23503',
      'environment_variables_environment_project_fk',
    );
    await expectPgError(
      insertVariable(db(), { scope: 'service', projectId: own.projectId, serviceId: other.serviceId }, 'K'),
      '23503',
      'environment_variables_service_project_fk',
    );
    await expectPgError(
      insertSecret(db(), { scope: 'environment', projectId: own.projectId, environmentId: other.environmentId }, 'S'),
      '23503',
      'secrets_environment_project_fk',
    );
    await expectPgError(
      insertSecret(db(), { scope: 'service', projectId: own.projectId, serviceId: other.serviceId }, 'S'),
      '23503',
      'secrets_service_project_fk',
    );
  });

  it('the owner columns must match the scope (CHECK)', async () => {
    const s = await seedScope(db());
    const mismatched: OwnerRef[] = [
      { scope: 'project', projectId: s.projectId, environmentId: s.environmentId },
      { scope: 'project', projectId: s.projectId, serviceId: s.serviceId },
      { scope: 'environment', projectId: s.projectId },
      { scope: 'environment', projectId: s.projectId, environmentId: s.environmentId, serviceId: s.serviceId },
      { scope: 'service', projectId: s.projectId },
      { scope: 'service', projectId: s.projectId, environmentId: s.environmentId },
    ];
    for (const owner of mismatched) {
      await expectPgError(insertVariable(db(), owner, 'KEY'), '23514', 'environment_variables_scope_owner_check');
      await expectPgError(insertSecret(db(), owner, 'NAME'), '23514', 'secrets_scope_owner_check');
    }
  });

  it('a variable key is unique per owner; a second insert fails with 23505 (H3)', async () => {
    const s = await seedScope(db());
    const projectOwner: OwnerRef = { scope: 'project', projectId: s.projectId };
    const environmentOwner: OwnerRef = { scope: 'environment', projectId: s.projectId, environmentId: s.environmentId };
    const serviceOwner: OwnerRef = { scope: 'service', projectId: s.projectId, serviceId: s.serviceId };
    for (const owner of [projectOwner, environmentOwner, serviceOwner]) {
      await insertVariable(db(), owner, 'DATABASE_URL');
      const error = await caught(insertVariable(db(), owner, 'DATABASE_URL', 'other'));
      expect(pgErrorOf(error)).toEqual({ code: '23505', constraint: ENVIRONMENT_VARIABLES_OWNER_KEY_UNIQUE_INDEX });
      expect(mapUniqueViolation(error)).toBe('ENV_KEY_DUPLICATE');
    }
    // Keys are case-sensitive (POSIX), so a differently cased key is another variable.
    await insertVariable(db(), projectOwner, 'database_url');
  });

  it('a secret name is unique per owner; a second insert fails with 23505 (H3)', async () => {
    const s = await seedScope(db());
    const owners: OwnerRef[] = [
      { scope: 'project', projectId: s.projectId },
      { scope: 'environment', projectId: s.projectId, environmentId: s.environmentId },
      { scope: 'service', projectId: s.projectId, serviceId: s.serviceId },
    ];
    for (const owner of owners) {
      await insertSecret(db(), owner, 'STRIPE_KEY');
      const error = await caught(insertSecret(db(), owner, 'STRIPE_KEY'));
      expect(pgErrorOf(error)).toEqual({ code: '23505', constraint: SECRETS_OWNER_NAME_UNIQUE_INDEX });
      expect(mapUniqueViolation(error)).toBe('SECRET_NAME_DUPLICATE');
    }
  });

  it('bounds keys, values, names and versions at the database', async () => {
    const s = await seedScope(db());
    const owner: OwnerRef = { scope: 'project', projectId: s.projectId };
    await expectPgError(insertVariable(db(), owner, 'K'.repeat(129)), '23514');
    await expectPgError(insertVariable(db(), owner, 'BIG', 'x'.repeat(32 * 1024 + 1)), '23514');
    await insertVariable(db(), owner, 'MAX', 'x'.repeat(32 * 1024));
    await expectPgError(insertSecret(db(), owner, 'S'.repeat(65)), '23514');
    await expectPgError(insertSecret(db(), owner, 'ZERO', 0), '23514');
  });

  it('round-trips a secret and a variable through the Drizzle schema (A2)', async () => {
    const s = await seedScope(db());
    const [secret] = await db()
      .insert(schema.secrets)
      .values({
        scope: 'service',
        projectId: s.projectId,
        serviceId: s.serviceId,
        name: 'API_TOKEN',
        encryptedValue: CIPHERTEXT,
        keyVersion: 1,
        hint: '…9f3c',
      })
      .returning();
    expect(secret).toMatchObject({ scope: 'service', version: 1, environmentId: null });
    const [variable] = await db()
      .insert(schema.environmentVariables)
      .values({ scope: 'environment', projectId: s.projectId, environmentId: s.environmentId, key: 'PORT', value: '8080' })
      .returning();
    expect(variable).toMatchObject({ scope: 'environment', key: 'PORT', value: '8080', serviceId: null });
  });

  it('deleting a service, environment or project cascades to its domains, variables and secrets', async () => {
    const s = await seedScope(db());
    await insertDomain(db(), s.projectId, s.serviceId, `cascade-${s.serviceId.slice(-8)}.example.com`);
    await insertVariable(db(), { scope: 'service', projectId: s.projectId, serviceId: s.serviceId }, 'A');
    await insertSecret(db(), { scope: 'service', projectId: s.projectId, serviceId: s.serviceId }, 'A');
    await insertVariable(db(), { scope: 'environment', projectId: s.projectId, environmentId: s.environmentId }, 'B');
    await insertSecret(db(), { scope: 'environment', projectId: s.projectId, environmentId: s.environmentId }, 'B');
    await insertVariable(db(), { scope: 'project', projectId: s.projectId }, 'C');
    await insertSecret(db(), { scope: 'project', projectId: s.projectId }, 'C');

    await db().execute(sql`delete from services where id = ${s.serviceId}`);
    expect(await count(db(), 'domains', 'service_id', s.serviceId)).toBe(0);
    expect(await count(db(), 'environment_variables', 'service_id', s.serviceId)).toBe(0);
    expect(await count(db(), 'secrets', 'service_id', s.serviceId)).toBe(0);

    await db().execute(sql`delete from environments where id = ${s.environmentId}`);
    expect(await count(db(), 'environment_variables', 'environment_id', s.environmentId)).toBe(0);
    expect(await count(db(), 'secrets', 'environment_id', s.environmentId)).toBe(0);
    expect(await count(db(), 'secrets', 'project_id', s.projectId)).toBe(1);

    await db().execute(sql`delete from projects where id = ${s.projectId}`);
    expect(await count(db(), 'environment_variables', 'project_id', s.projectId)).toBe(0);
    expect(await count(db(), 'secrets', 'project_id', s.projectId)).toBe(0);
  });

  it('re-executing every 0014 and 0015 statement on a fully migrated database is a no-op', async () => {
    for (const tag of [MIGRATION_0014, MIGRATION_0015]) {
      for (const statement of statementsOf(tag)) {
        await db().execute(sql.raw(statement));
      }
    }
    const enums = await db().execute<{ n: number }>(
      sql`select count(*)::int as n from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'env_scope'`,
    );
    expect(enums.rows[0]?.n).toBe(3);
  });
});

describe('migrations 0014/0015 upgrading the v0.3.0 schema (21-06 A1)', () => {
  let fixture: PostgresFixture | undefined;

  afterAll(async () => {
    await fixture?.stop();
    fixture = undefined;
    await expectNoStrayContainers();
  });

  it('applies over v0.3.0 data in one migrator run and keeps every row unchanged', async () => {
    fixture = await startPostgres({ migrate: false });
    const { db } = fixture;
    await applyMigrationsUpTo(db, V030_TAG);

    const scope = await seedScope(db);
    await db.execute(sql`
      insert into deployments (id, service_id, status, source, error_code)
      values (${uuidv7()}, ${scope.serviceId}, 'FAILED', '{"type":"image"}'::jsonb, 'HEALTHCHECK_FAILED')
    `);
    const tables = ['servers', 'projects', 'environments', 'services', 'deployments', 'credentials'];
    const before = await Promise.all(tables.map((table) => db.execute(sql`select * from ${sql.identifier(table)} order by id`)));

    await runMigrations(db);

    const after = await Promise.all(
      tables.map((table) => db.execute<Record<string, unknown>>(sql`select * from ${sql.identifier(table)} order by id`)),
    );
    tables.forEach((table, index) => {
      const rowsBefore = before[index]?.rows ?? [];
      expect(after[index]?.rows, table).toEqual(rowsBefore.map((row) => expect.objectContaining(row)));
    });
    expect(after[0]?.rows[0]).toMatchObject({ proxy_status: 'NOT_INSTALLED', proxy_error_code: null });

    await insertDomain(db, scope.projectId, scope.serviceId, 'upgraded.example.com');
    await insertSecret(db, { scope: 'project', projectId: scope.projectId }, 'UPGRADED');
    await db.execute(sql`
      insert into deployments (id, service_id, status, source, error_code)
      values (${uuidv7()}, ${scope.serviceId}, 'FAILED', '{"type":"image"}'::jsonb, 'SECRET_UNRESOLVED')
    `);
  });
});
