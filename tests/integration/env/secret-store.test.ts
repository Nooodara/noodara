// SEC-04 (23-01 A3, H1, H3): the secret store against real Postgres. Keys and secret values are
// generated per run, never committed literals.
import { randomBytes, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRedactor, decryptSecret, encryptSecret, revealSecret, secretValue, type EncryptedBlob } from '@noodara/domain/security';
import { secretsRotateCommand } from '../../../apps/control-plane/src/cli/secrets-rotate.js';
import { credentials } from '../../../apps/control-plane/src/db/schema/credentials.js';
import { environments } from '../../../apps/control-plane/src/db/schema/environments.js';
import { projects } from '../../../apps/control-plane/src/db/schema/projects.js';
import { secrets } from '../../../apps/control-plane/src/db/schema/secrets.js';
import { servers } from '../../../apps/control-plane/src/db/schema/servers.js';
import { services } from '../../../apps/control-plane/src/db/schema/services.js';
import {
  createSecret,
  decryptForDeploy,
  replaceSecret,
  SecretStoreError,
  type ScopeChain,
} from '../../../apps/control-plane/src/secrets/secret-store.js';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';

const OLD_KEY = randomBytes(32);
const NEW_KEY = randomBytes(32);

let fixture: PostgresFixture | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  await fixture?.stop();
  fixture = undefined;

  // noodara-tdd skill §5: no stray container labelled noodara.test=true survives a run.
  const { getContainerRuntimeClient } = await import('testcontainers');
  const client = await getContainerRuntimeClient();
  const containers = await client.container.list();
  expect(containers.filter((c) => c.Labels['noodara.test'] === 'true')).toHaveLength(0);
});

function canary(length = 40): string {
  return `${randomBytes(length).toString('base64url').slice(0, length)}`;
}

function appSecret(raw: string) {
  return secretValue(raw, 'app_secret');
}

let seeded = 0;

async function seedChain(db: PostgresFixture['db']): Promise<ScopeChain> {
  const now = new Date();
  seeded += 1;
  const seq = seeded;
  const [credential] = await db
    .insert(credentials)
    .values({ type: 'ssh_password', encryptedValue: encryptSecret(canary(), { key: OLD_KEY, version: 1 }), keyVersion: 1 })
    .returning({ id: credentials.id });
  const [server] = await db
    .insert(servers)
    .values({ name: `srv-${randomUUID().slice(0, 8)}`, host: '192.0.2.10', sshPort: 2200 + seq, sshUser: 'root', credentialId: credential!.id })
    .returning({ id: servers.id });
  const [project] = await db
    .insert(projects)
    .values({ name: `Secrets ${seq.toString()}`, slug: `sec-${randomUUID().slice(0, 8)}`, createdAt: now, updatedAt: now })
    .returning({ id: projects.id });
  const [environment] = await db
    .insert(environments)
    .values({ projectId: project!.id, name: 'production' })
    .returning({ id: environments.id });
  const [service] = await db
    .insert(services)
    .values({
      projectId: project!.id,
      environmentId: environment!.id,
      serverId: server!.id,
      name: `svc-${randomUUID().slice(0, 8)}`,
      sourceType: 'image',
      imageRef: 'nginx:1.27-alpine',
      internalPort: 80,
    })
    .returning({ id: services.id });
  return { projectId: project!.id, environmentId: environment!.id, serviceId: service!.id };
}

/** Polls until another backend is waiting on a row lock, so a concurrency test is deterministic. */
async function waitForLockWaiter(db: PostgresFixture['db']): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`,
    );
    if ((result.rows[0]?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('no backend ever waited on the row lock');
}

describe('secret store (SEC-04)', () => {
  it('creates at every scope, replaces with version + 1 and decrypts within the chain only', async () => {
    fixture = await startPostgres();
    const chain = await seedChain(fixture.db);
    const keys = { current: OLD_KEY };
    const values = { project: canary(), environment: canary(), service: canary(), short: 'abc' };

    const project = await createSecret(fixture.db, { owner: { scope: 'project', projectId: chain.projectId }, name: 'p_token', value: appSecret(values.project) }, keys);
    const environment = await createSecret(
      fixture.db,
      { owner: { scope: 'environment', projectId: chain.projectId, environmentId: chain.environmentId }, name: 'e_token', value: appSecret(values.environment) },
      keys,
    );
    const service = await createSecret(
      fixture.db,
      { owner: { scope: 'service', projectId: chain.projectId, serviceId: chain.serviceId }, name: 's_token', value: appSecret(values.service) },
      keys,
    );
    const short = await createSecret(fixture.db, { owner: { scope: 'project', projectId: chain.projectId }, name: 'pin', value: appSecret(values.short) }, keys);

    expect(project.version).toBe(1);
    expect(project.hint).toBe(values.project.slice(-4));
    expect(short.hint).toBe('');
    for (const record of [project, environment, service, short]) {
      expect(record).not.toHaveProperty('encryptedValue');
      expect(JSON.stringify(record)).not.toContain(values.project);
    }

    const replacement = canary();
    const replaced = await replaceSecret(fixture.db, project.id, appSecret(replacement), keys);
    expect(replaced.version).toBe(2);
    expect(replaced.hint).toBe(replacement.slice(-4));
    expect(JSON.stringify(replaced)).not.toContain(replacement);

    const [stored] = await fixture.db.select().from(secrets).where(eq(secrets.id, project.id));
    expect(stored!.encryptedValue).not.toContain(replacement);

    const redactor = createRedactor();
    const lease = await decryptForDeploy(
      fixture.db,
      { chain, secretIds: [project.id, environment.id, service.id, short.id] },
      keys,
      redactor,
    );
    expect(revealSecret(lease.values.get(project.id)!)).toBe(replacement);
    expect(revealSecret(lease.values.get(environment.id)!)).toBe(values.environment);
    expect(revealSecret(lease.values.get(service.id)!)).toBe(values.service);
    expect([...lease.values.values()].every((value) => value.kind === 'app_secret')).toBe(true);
    expect(redactor.redact(`x ${replacement} y`)).toBe('x [REDACTED:app_secret] y');
    expect(redactor.redact('abcdef abc')).toBe('abcdef abc');
    lease.release();
    expect(redactor.redact(`x ${replacement} y`)).toBe(`x ${replacement} y`);
  });

  it('H1: refuses a foreign-project secret id with SECRET_NOT_IN_SCOPE and registers nothing', async () => {
    fixture = await startPostgres();
    const chain = await seedChain(fixture.db);
    const foreign = await seedChain(fixture.db);
    const keys = { current: OLD_KEY };
    const own = await createSecret(fixture.db, { owner: { scope: 'project', projectId: chain.projectId }, name: 'own', value: appSecret(canary()) }, keys);
    const foreignValue = canary();
    const other = await createSecret(
      fixture.db,
      { owner: { scope: 'service', projectId: foreign.projectId, serviceId: foreign.serviceId }, name: 'own', value: appSecret(foreignValue) },
      keys,
    );
    const redactor = createRedactor();
    const register = vi.spyOn(redactor, 'register');

    const error = await decryptForDeploy(fixture.db, { chain, secretIds: [own.id, other.id] }, keys, redactor).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SecretStoreError);
    expect((error as SecretStoreError).code).toBe('SECRET_NOT_IN_SCOPE');
    expect((error as SecretStoreError).secretId).toBe(other.id);
    expect(JSON.stringify(error)).not.toContain(foreignValue);
    expect(register).not.toHaveBeenCalled();

    // A sibling environment of the same project is outside the chain too.
    const [sibling] = await fixture.db
      .insert(environments)
      .values({ projectId: chain.projectId, name: 'staging' })
      .returning({ id: environments.id });
    const siblingSecret = await createSecret(
      fixture.db,
      { owner: { scope: 'environment', projectId: chain.projectId, environmentId: sibling!.id }, name: 'sib', value: appSecret(canary()) },
      keys,
    );
    await expect(decryptForDeploy(fixture.db, { chain, secretIds: [siblingSecret.id] }, keys, redactor)).rejects.toMatchObject({
      code: 'SECRET_NOT_IN_SCOPE',
    });
  });

  it('A3: tamper, wrong-key and malformed rows surface as named store errors; the logger canary shows only [REDACTED:app_secret]', async () => {
    fixture = await startPostgres();
    const chain = await seedChain(fixture.db);
    const keys = { current: OLD_KEY };
    const value = canary(48);
    const good = await createSecret(fixture.db, { owner: { scope: 'project', projectId: chain.projectId }, name: 'good', value: appSecret(value) }, keys);

    vi.stubEnv('NOODARA_MASTER_KEY', OLD_KEY.toString('base64'));
    vi.stubEnv('BETTER_AUTH_SECRET', `test-fixture-${randomUUID()}-${randomUUID()}`);
    vi.stubEnv('DATABASE_URL', fixture.connectionString);
    vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
    vi.stubEnv('NOODARA_PUBLIC_URL', 'http://localhost:3000');
    vi.resetModules();
    const { createLogger, writableForTests } = await import('../../../apps/control-plane/src/logger.js');
    const capture = writableForTests();
    const logger = createLogger({ destination: capture.stream, level: 'info' });

    const redactor = createRedactor();
    const lease = await decryptForDeploy(fixture.db, { chain, secretIds: [good.id] }, keys, redactor);
    const secret = lease.values.get(good.id)!;
    logger.info({ secret }, 'resolved secret');
    logger.info(redactor.redact(`docker create --env API_TOKEN=${revealSecret(secret)}`));
    lease.release();

    const cases: { name: string; blob: string; keyVersion: number; code: string }[] = [
      { name: 'tampered', blob: (() => { const p = encryptSecret(value, { key: OLD_KEY, version: 1 }).split(':'); return [...p.slice(0, 3), randomBytes(16).toString('base64')].join(':'); })(), keyVersion: 1, code: 'SECRET_TAMPERED' },
      { name: 'wrong_key', blob: encryptSecret(value, { key: randomBytes(32), version: 1 }), keyVersion: 1, code: 'SECRET_TAMPERED' },
      { name: 'malformed', blob: 'v1:not:a:blob', keyVersion: 1, code: 'SECRET_MALFORMED' },
    ];
    for (const c of cases) {
      const [row] = await fixture.db
        .insert(secrets)
        .values({ scope: 'project', projectId: chain.projectId, name: c.name, encryptedValue: c.blob, keyVersion: c.keyVersion, hint: '' })
        .returning({ id: secrets.id });
      const error = await decryptForDeploy(fixture.db, { chain, secretIds: [row!.id] }, keys, redactor).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SecretStoreError);
      expect((error as SecretStoreError).code).toBe(c.code);
      logger.error({ err: error, code: (error as SecretStoreError).code }, 'secret decrypt failed');
      expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(value);
    }

    const output = JSON.stringify(capture.records());
    expect(output).not.toContain(value);
    expect(output).toContain('[REDACTED:app_secret]');
    expect(output).toContain('SECRET_TAMPERED');
  });

  it('H3: two concurrent replaces end at version 3 with the ciphertext of the last committed write', async () => {
    fixture = await startPostgres();
    const db = fixture.db;
    const chain = await seedChain(db);
    const keys = { current: OLD_KEY };
    const created = await createSecret(db, { owner: { scope: 'project', projectId: chain.projectId }, name: 'race', value: appSecret(canary()) }, keys);
    const first = canary();
    const second = canary();

    let pending: Promise<unknown> | undefined;
    await db.transaction(async (tx) => {
      await replaceSecret(tx, created.id, appSecret(first), keys);
      pending = replaceSecret(db, created.id, appSecret(second), keys);
      await waitForLockWaiter(db);
    });
    await pending;

    const [row] = await db.select().from(secrets).where(eq(secrets.id, created.id));
    expect(row!.version).toBe(3);
    expect(decryptSecret(row!.encryptedValue as EncryptedBlob, new Map([[row!.keyVersion, OLD_KEY]]))).toBe(second);

    // Unordered: still exactly +2, never a lost increment.
    await Promise.all([
      replaceSecret(db, created.id, appSecret(canary()), keys),
      replaceSecret(db, created.id, appSecret(canary()), keys),
    ]);
    const [after] = await db.select().from(secrets).where(eq(secrets.id, created.id));
    expect(after!.version).toBe(5);
  });

  it('H3: secrets rotate concurrent with a replace keeps the replaced value and a key_version that matches its ciphertext', async () => {
    fixture = await startPostgres();
    const db = fixture.db;
    const chain = await seedChain(db);
    const oldKeys = { current: OLD_KEY };
    const windowKeys = { current: NEW_KEY, previous: OLD_KEY };
    const untouched = canary();
    const target = await createSecret(db, { owner: { scope: 'project', projectId: chain.projectId }, name: 'target', value: appSecret(canary()) }, oldKeys);
    const other = await createSecret(db, { owner: { scope: 'project', projectId: chain.projectId }, name: 'other', value: appSecret(untouched) }, oldKeys);
    const replacement = canary();
    const logger = { error: vi.fn(), info: vi.fn() };
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    let rotation: Promise<number> | undefined;
    try {
      await db.transaction(async (tx) => {
        await replaceSecret(tx, target.id, appSecret(replacement), windowKeys);
        rotation = secretsRotateCommand({
          db,
          env: {
            NOODARA_MASTER_KEY: NEW_KEY.toString('base64'),
            NOODARA_MASTER_KEY_PREVIOUS: OLD_KEY.toString('base64'),
          } as Parameters<typeof secretsRotateCommand>[0]['env'],
          logger,
        });
        await waitForLockWaiter(db);
      });
      expect(await rotation).toBe(0);
    } finally {
      stdout.mockRestore();
    }

    const rows = await db.select().from(secrets);
    for (const row of rows) {
      expect(row.encryptedValue.startsWith(`v${row.keyVersion.toString()}:`)).toBe(true);
      expect(row.keyVersion).toBe(2);
    }
    const byId = new Map(rows.map((row) => [row.id, row]));
    const decrypt = (id: string) => {
      const row = byId.get(id)!;
      return decryptSecret(row.encryptedValue as EncryptedBlob, new Map([[row.keyVersion, NEW_KEY]]));
    };
    expect(decrypt(target.id)).toBe(replacement);
    expect(byId.get(target.id)!.version).toBe(2);
    expect(decrypt(other.id)).toBe(untouched);

    // After the rotation the store decrypts with the new key alone.
    const lease = await decryptForDeploy(db, { chain, secretIds: [target.id, other.id] }, { current: NEW_KEY }, createRedactor());
    expect(revealSecret(lease.values.get(target.id)!)).toBe(replacement);
    lease.release();
  });
});
