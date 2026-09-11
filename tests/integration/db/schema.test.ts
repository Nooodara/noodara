import { afterEach, describe, expect, it } from 'vitest';
import * as schema from '../../../apps/control-plane/src/db/schema/index.js';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';

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

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let fixture: PostgresFixture | undefined;

afterEach(async () => {
  await fixture?.stop();
  fixture = undefined;

  // noodara-tdd skill §5: no stray container labelled noodara.test=true survives a run.
  const { getContainerRuntimeClient } = await import('testcontainers');
  const client = await getContainerRuntimeClient();
  const containers = await client.container.list();
  const stray = containers.filter((c) => c.Labels['noodara.test'] === 'true');
  expect(stray).toHaveLength(0);
});

describe('phase-1 schema (Testcontainers harness)', () => {
  it('creates all eight tables and seven status/purpose enums', async () => {
    fixture = await startPostgres();

    const tables = await fixture.db.execute<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public'",
    );
    const tableNames = tables.rows.map((row) => row.table_name);
    for (const expected of EXPECTED_TABLES) {
      expect(tableNames).toContain(expected);
    }

    const enums = await fixture.db.execute<{ typname: string }>(
      "select typname from pg_type where typtype = 'e'",
    );
    const enumNames = enums.rows.map((row) => row.typname);
    for (const expected of EXPECTED_ENUMS) {
      expect(enumNames).toContain(expected);
    }
  });

  it('assigns a UUIDv7 id and defaults status to PENDING on insert', async () => {
    fixture = await startPostgres();

    const insertedCredentials = await fixture.db
      .insert(schema.credentials)
      .values({ type: 'ssh_password', encryptedValue: 'v1:nonce:cipher:tag', keyVersion: 1 })
      .returning();
    const credential = insertedCredentials[0];
    if (!credential) throw new Error('expected the credential insert to return a row');

    const insertedServers = await fixture.db
      .insert(schema.servers)
      .values({ name: 'test-server', host: '127.0.0.1', sshUser: 'root', credentialId: credential.id })
      .returning();
    const server = insertedServers[0];
    if (!server) throw new Error('expected the server insert to return a row');

    expect(server.id).toMatch(UUID_V7_PATTERN);
    expect(server.status).toBe('PENDING');
  });
});
