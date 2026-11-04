import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRedactor } from '@noodara/domain/security';
import type { Database } from '../../../apps/control-plane/src/db/client.js';
import { MIGRATIONS_FOLDER, runMigrations } from '../../../apps/control-plane/src/db/migrate.js';
import {
  insertAiConversation,
  insertAiMessage,
  redactForStorage,
  updateAiMessage,
} from '../../../apps/control-plane/src/db/schema/repositories/ai-message-repository.js';
import { applyMigrationsUpTo, readJournal } from '../helpers/migrations.js';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';

// 26-05: 0018 only grows two enums (actor ai, credential type ai_provider_key); 0019 creates the
// v0.5 metric, observation and AI tables. Samples and observations cascade with their server or
// service; deleting the AI provider settings deletes its encrypted key in the same transaction
// (trigger); AI text columns are written only through the Redacted-only repository (H1).

const V040_TAG = '0017_phase23_configure_step';
const MIGRATION_0018 = '0018_phase26_v05_enums';
const MIGRATION_0019 = '0019_phase26_v05_tables';
const CIPHERTEXT = 'v1:bm9uY2U=:Y2lwaGVy:dGFn';
const CONTAINER_ID = 'a'.repeat(64);
const CANARY = 'nd-canary-ai-0019-5e2b8d14c7';

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

async function caught(action: Promise<unknown>): Promise<unknown> {
  try {
    await action;
  } catch (error) {
    return error;
  }
  return undefined;
}

let portSeed = 31_000;

interface Scope {
  readonly serverId: string;
  readonly serviceId: string;
}

async function insertCredential(db: Database, type = 'ssh_password'): Promise<string> {
  const id = uuidv7();
  await db.execute(sql`
    insert into credentials (id, type, encrypted_value, key_version)
    values (${id}, ${type}::credential_type, ${CIPHERTEXT}, 1)
  `);
  return id;
}

async function seedServer(db: Database): Promise<string> {
  const credentialId = await insertCredential(db);
  const serverId = uuidv7();
  portSeed += 1;
  await db.execute(sql`
    insert into servers (id, name, host, ssh_port, ssh_user, credential_id)
    values (${serverId}, ${`srv-${serverId.slice(-12)}`}, '10.5.0.1', ${portSeed}, 'root', ${credentialId})
  `);
  return serverId;
}

async function seedScope(db: Database): Promise<Scope> {
  const serverId = await seedServer(db);
  const projectId = uuidv7();
  const environmentId = uuidv7();
  const serviceId = uuidv7();
  const suffix = serviceId.slice(-12);
  await db.execute(sql`insert into projects (id, name, slug) values (${projectId}, ${`p-${suffix}`}, ${`p-${suffix}`})`);
  await db.execute(
    sql`insert into environments (id, project_id, name) values (${environmentId}, ${projectId}, 'production')`,
  );
  await db.execute(sql`
    insert into services (id, project_id, environment_id, server_id, name, source_type, image_ref, internal_port)
    values (${serviceId}, ${projectId}, ${environmentId}, ${serverId}, ${`svc-${suffix}`}, 'image', 'nginx:1.27-alpine', 80)
  `);
  return { serverId, serviceId };
}

function insertHostSample(db: Database, serverId: string): Promise<unknown> {
  return db.execute(sql`
    insert into host_metric_samples (id, server_id, sampled_at, cpu_percent, memory_total_bytes, memory_used_bytes, uptime_seconds)
    values (${uuidv7()}, ${serverId}, now(), 12.5, 1024, 512, 3600)
  `);
}

function insertContainerSample(db: Database, serviceId: string): Promise<unknown> {
  return db.execute(sql`
    insert into container_metric_samples (id, service_id, container_id, sampled_at, running, restart_count)
    values (${uuidv7()}, ${serviceId}, ${CONTAINER_ID}, now(), true, 0)
  `);
}

function insertObservation(db: Database, serviceId: string): Promise<unknown> {
  return db.execute(sql`
    insert into container_observations (id, service_id, container_id, observed_at, status, running)
    values (${uuidv7()}, ${serviceId}, ${CONTAINER_ID}, now(), 'running', true)
  `);
}

async function insertSettings(db: Database, credentialId: string): Promise<string> {
  const id = uuidv7();
  await db.execute(sql`
    insert into ai_provider_settings (id, provider, model, credential_id, key_hint, validated_at)
    values (${id}, 'anthropic', 'claude-sonnet', ${credentialId}, '••••••••a1b2', now())
  `);
  return id;
}

async function insertUser(db: Database): Promise<string> {
  const id = uuidv7();
  await db.execute(sql`insert into users (id, name, email) values (${id}, 'Ada', ${`${id}@example.com`})`);
  return id;
}

async function count(db: Database, table: string, column: string, value: string): Promise<number> {
  const result = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from ${sql.identifier(table)} where ${sql.identifier(column)} = ${value}`,
  );
  return result.rows[0]?.n ?? -1;
}

async function columnNames(db: Database, table: string): Promise<string[]> {
  const result = await db.execute<{ column_name: string }>(sql`
    select column_name from information_schema.columns
    where table_schema = 'public' and table_name = ${table}
  `);
  return result.rows.map((row) => row.column_name).sort();
}

describe('migrations 0018/0019 files (26-05 A1, A2)', () => {
  it('the journal holds 0017, 0018 then 0019 consecutively', () => {
    const journal = readJournal();
    const at = journal.indexOf(V040_TAG);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(journal.slice(at, at + 3)).toEqual([V040_TAG, MIGRATION_0018, MIGRATION_0019]);
  });

  it('0018 only adds the two v0.5 enum values with ADD VALUE IF NOT EXISTS', () => {
    const statements = statementsOf(MIGRATION_0018);
    expect(statements).toEqual([
      `ALTER TYPE "public"."activity_actor_type" ADD VALUE IF NOT EXISTS 'ai';`,
      `ALTER TYPE "public"."credential_type" ADD VALUE IF NOT EXISTS 'ai_provider_key';`,
    ]);
  });

  it('0019 creates no type, adds no enum value, drops nothing and never names a 0018 value', () => {
    for (const statement of statementsOf(MIGRATION_0019)) {
      expect(statement).not.toMatch(/CREATE TYPE|ADD VALUE|\bDROP\b|'ai'|'ai_provider_key'/i);
    }
  });
});

describe('v0.5 schema on a fresh database (26-05 A1, A3, H1)', () => {
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

  it('adds the ai actor and the ai_provider_key credential type', async () => {
    const result = await db().execute<{ typname: string; enumlabel: string }>(sql`
      select t.typname, e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid
      where (t.typname = 'activity_actor_type' and e.enumlabel = 'ai')
         or (t.typname = 'credential_type' and e.enumlabel = 'ai_provider_key')
    `);
    expect(result.rows).toHaveLength(2);
  });

  it('ai_provider_settings holds only a credential reference and a short hint, never a key (H1)', async () => {
    expect(await columnNames(db(), 'ai_provider_settings')).toEqual(
      [
        'id',
        'singleton',
        'provider',
        'model',
        'credential_id',
        'key_hint',
        'validated_at',
        'created_at',
        'updated_at',
      ].sort(),
    );
    const credentialId = await insertCredential(db(), 'ai_provider_key');
    const longHint = db().execute(sql`
      insert into ai_provider_settings (id, provider, model, credential_id, key_hint, validated_at)
      values (${uuidv7()}, 'anthropic', 'm', ${credentialId}, ${'sk-ant-api03-' + 'x'.repeat(40)}, now())
    `);
    expect(await caught(longHint)).toBeDefined();
    expect(await count(db(), 'ai_provider_settings', 'credential_id', credentialId)).toBe(0);
  });

  it('metric samples and observations have a sampled_at/observed_at index', async () => {
    const result = await db().execute<{ indexname: string }>(sql`
      select indexname from pg_indexes where schemaname = 'public'
      and tablename in ('host_metric_samples', 'container_metric_samples', 'container_observations')
    `);
    expect(result.rows.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        'host_metric_samples_sampled_at_idx',
        'host_metric_samples_server_sampled_at_idx',
        'container_metric_samples_sampled_at_idx',
        'container_metric_samples_service_sampled_at_idx',
        'container_observations_observed_at_idx',
        'container_observations_service_observed_at_idx',
      ]),
    );
  });

  it('deleting a server cascades its host samples (A3)', async () => {
    const serverId = await seedServer(db());
    await insertHostSample(db(), serverId);
    await insertHostSample(db(), serverId);
    expect(await count(db(), 'host_metric_samples', 'server_id', serverId)).toBe(2);
    await db().execute(sql`delete from servers where id = ${serverId}`);
    expect(await count(db(), 'host_metric_samples', 'server_id', serverId)).toBe(0);
  });

  it('deleting a service cascades its container samples and observations (A3)', async () => {
    const { serviceId } = await seedScope(db());
    await insertContainerSample(db(), serviceId);
    await insertObservation(db(), serviceId);
    await db().execute(sql`delete from services where id = ${serviceId}`);
    expect(await count(db(), 'container_metric_samples', 'service_id', serviceId)).toBe(0);
    expect(await count(db(), 'container_observations', 'service_id', serviceId)).toBe(0);
  });

  it('deleting the settings deletes its encrypted key in the same transaction (A3)', async () => {
    const credentialId = await insertCredential(db(), 'ai_provider_key');
    const settingsId = await insertSettings(db(), credentialId);

    const rollback = new Error('rollback');
    const outcome = await caught(
      db().transaction(async (tx) => {
        await tx.execute(sql`delete from ai_provider_settings where id = ${settingsId}`);
        const inside = await tx.execute<{ n: number }>(
          sql`select count(*)::int as n from credentials where id = ${credentialId}`,
        );
        expect(inside.rows[0]?.n).toBe(0);
        throw rollback;
      }),
    );
    expect(outcome).toBe(rollback);
    expect(await count(db(), 'ai_provider_settings', 'id', settingsId)).toBe(1);
    expect(await count(db(), 'credentials', 'id', credentialId)).toBe(1);

    await db().execute(sql`delete from ai_provider_settings where id = ${settingsId}`);
    expect(await count(db(), 'credentials', 'id', credentialId)).toBe(0);
  });

  it('replacing the key deletes the previous encrypted key; other updates keep it', async () => {
    const oldKey = await insertCredential(db(), 'ai_provider_key');
    const settingsId = await insertSettings(db(), oldKey);
    await db().execute(sql`update ai_provider_settings set model = 'other' where id = ${settingsId}`);
    expect(await count(db(), 'credentials', 'id', oldKey)).toBe(1);

    const newKey = await insertCredential(db(), 'ai_provider_key');
    await db().execute(sql`update ai_provider_settings set credential_id = ${newKey} where id = ${settingsId}`);
    expect(await count(db(), 'credentials', 'id', oldKey)).toBe(0);
    expect(await count(db(), 'credentials', 'id', newKey)).toBe(1);

    await db().execute(sql`delete from ai_provider_settings where id = ${settingsId}`);
    expect(await count(db(), 'credentials', 'id', newKey)).toBe(0);
  });

  it('a second settings row is rejected (singleton)', async () => {
    const first = await insertCredential(db(), 'ai_provider_key');
    const second = await insertCredential(db(), 'ai_provider_key');
    const settingsId = await insertSettings(db(), first);
    expect(await caught(insertSettings(db(), second))).toBeDefined();
    await db().execute(sql`delete from ai_provider_settings where id = ${settingsId}`);
    await db().execute(sql`delete from credentials where id = ${second}`);
  });

  it('messages written through the repository never store a registered secret (H1)', async () => {
    const redactor = createRedactor();
    redactor.register(CANARY, 'ai_provider_key');
    const userId = await insertUser(db());
    const conversation = await insertAiConversation(db(), {
      userId,
      title: redactForStorage<string>(redactor, `why ${CANARY}`),
    });
    const message = await insertAiMessage(db(), {
      conversationId: conversation.id,
      role: 'user',
      status: 'pending',
      content: redactForStorage<string>(redactor, `my key is ${CANARY}`),
    });
    await updateAiMessage(db(), message.id, {
      status: 'complete',
      content: redactForStorage<string>(redactor, `still ${CANARY}`),
    });
    await db().execute(sql`
      insert into ai_tool_calls (id, message_id, name, scope_kind, scope_id, status, duration_ms)
      values (${uuidv7()}, ${message.id}, 'get_service', 'Service', ${uuidv7()}, 'ok', 12)
    `);

    const stored = await db().execute(sql`
      select c.title, m.content, m.answer from ai_conversations c
      join ai_messages m on m.conversation_id = c.id where c.id = ${conversation.id}
    `);
    expect(stored.rows).toHaveLength(1);
    const serialized = JSON.stringify(stored.rows);
    expect(serialized).not.toContain(CANARY);
    expect(serialized).toContain('[REDACTED:ai_provider_key]');

    await db().execute(sql`delete from users where id = ${userId}`);
    expect(await count(db(), 'ai_messages', 'id', message.id)).toBe(0);
    expect(await count(db(), 'ai_tool_calls', 'message_id', message.id)).toBe(0);
  });

  it('re-executing every 0018 and 0019 statement on a fully migrated database is a no-op', async () => {
    for (const tag of [MIGRATION_0018, MIGRATION_0019]) {
      for (const statement of statementsOf(tag)) {
        await db().execute(sql.raw(statement));
      }
    }
    const triggers = await db().execute<{ n: number }>(sql`
      select count(*)::int as n from pg_trigger where tgname = 'ai_provider_settings_delete_credential_trg'
    `);
    expect(triggers.rows[0]?.n).toBe(1);
  });
});

describe('migrations 0018/0019 upgrading the v0.4.0 schema (26-05 A2)', () => {
  let fixture: PostgresFixture | undefined;

  afterAll(async () => {
    await fixture?.stop();
    fixture = undefined;
    await expectNoStrayContainers();
  });

  it('applies over v0.4.0 data in one migrator run and keeps every row unchanged', async () => {
    fixture = await startPostgres({ migrate: false });
    const { db } = fixture;
    await applyMigrationsUpTo(db, V040_TAG);

    const scope = await seedScope(db);
    const tables = ['servers', 'projects', 'environments', 'services', 'credentials'];
    const before = await Promise.all(tables.map((table) => db.execute(sql`select * from ${sql.identifier(table)} order by id`)));

    await runMigrations(db);

    const after = await Promise.all(tables.map((table) => db.execute(sql`select * from ${sql.identifier(table)} order by id`)));
    tables.forEach((table, index) => {
      expect(after[index]?.rows, table).toEqual(before[index]?.rows);
    });

    await insertHostSample(db, scope.serverId);
    await insertObservation(db, scope.serviceId);
    const credentialId = await insertCredential(db, 'ai_provider_key');
    await insertSettings(db, credentialId);
    expect(await count(db, 'ai_provider_settings', 'credential_id', credentialId)).toBe(1);
  });
});
