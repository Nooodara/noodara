// SERV-01/ACT-01: RED for `registerServer`. Every expectation below fails today for the same
// reason — `apps/control-plane/src/services/register-server.ts` does not exist yet — proven by
// 03-05-PLAN.md's own acceptance criteria (the failure message must name the missing module, not
// a harness bug). `registerServer` itself is loaded via a dynamic `await import(...)` on every
// call (never a static top-level import), mirroring `service-fixture.ts`'s own discipline: the
// module transitively imports `apps/control-plane/src/activity/redaction.ts`, which reads
// `env.NOODARA_MASTER_KEY` at import time (INST-06) and would otherwise crash the whole worker
// process if imported before `startServiceFixture()` has written a valid test env.
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  activityEvents,
  credentials,
  servers,
} from '../../../apps/control-plane/src/db/schema/index.js';
import { assertNoStrayTestContainers } from '../helpers/ssh.js';
import { startServiceFixture, type ServiceFixture } from './helpers/service-fixture.js';

let fixture: ServiceFixture | undefined;

afterEach(async () => {
  await fixture?.stop();
  fixture = undefined;

  // noodara-tdd skill §5: no stray container labelled noodara.test=true survives a run.
  await assertNoStrayTestContainers();
});

function buildRsaPem(modulusLength: number): string {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  return privateKey;
}

/** Real, per-run RSA key material — never a committed literal. RSA-2048 PKCS#1 PEM is one of
 *  `@noodara/ssh`'s `loadPrivateKey` accepted forms (D-01); RSA-1024 is deliberately below its
 *  2048-bit minimum, the D-15 pre-persist rejection this suite exercises. */
const VALID_PRIVATE_KEY = buildRsaPem(2048);
const TOO_SMALL_PRIVATE_KEY = buildRsaPem(1024);

function freshPassword(): string {
  return randomBytes(24).toString('base64url');
}

function uniqueName(): string {
  return `srv-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function uniqueHost(): string {
  return `${randomUUID().replace(/-/g, '').slice(0, 12)}.example.test`;
}

type FixtureCredential =
  | { readonly kind: 'password'; readonly password: string }
  | { readonly kind: 'private_key'; readonly privateKey: string; readonly passphrase?: string };

type FixtureActor = { readonly type: 'user'; readonly id: string } | { readonly type: 'system' };

interface RegisterFixtureServerOverrides {
  readonly name?: string;
  readonly host?: string;
  readonly sshPort?: number;
  readonly sshUser?: string;
  readonly credential?: FixtureCredential;
  readonly actor?: FixtureActor;
}

/** Loaded dynamically on every call — see the file-header note on why this cannot be a static
 *  top-level import. */
async function loadRegisterServer() {
  return import('../../../apps/control-plane/src/services/register-server.js');
}

async function registerFixtureServer(fx: ServiceFixture, overrides: RegisterFixtureServerOverrides = {}) {
  const { registerServer } = await loadRegisterServer();
  return registerServer(fx.deps, {
    actor: overrides.actor ?? { type: 'system' },
    name: overrides.name ?? uniqueName(),
    host: overrides.host ?? uniqueHost(),
    ...(overrides.sshPort !== undefined ? { sshPort: overrides.sshPort } : {}),
    ...(overrides.sshUser !== undefined ? { sshUser: overrides.sshUser } : {}),
    credential: overrides.credential ?? { kind: 'password', password: freshPassword() },
  });
}

interface TableCounts {
  readonly servers: number;
  readonly credentials: number;
  readonly activityEvents: number;
}

async function tableCounts(fx: ServiceFixture): Promise<TableCounts> {
  const [serverRows, credentialRows, activityRows] = await Promise.all([
    fx.db.select({ id: servers.id }).from(servers),
    fx.db.select({ id: credentials.id }).from(credentials),
    fx.db.select({ id: activityEvents.id }).from(activityEvents),
  ]);
  return { servers: serverRows.length, credentials: credentialRows.length, activityEvents: activityRows.length };
}

describe('registerServer (SERV-01, ACT-01)', () => {
  it('registers with a password credential, defaulting sshPort/sshUser and status PENDING', async () => {
    fixture = await startServiceFixture();

    const result = await registerFixtureServer(fixture);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.server.status).toBe('PENDING');
    expect(result.server.sshPort).toBe(22);
    expect(result.server.sshUser).toBe('root');
    expect(result.server.credentialType).toBe('ssh_password');
    expect(result.server.hostFingerprint).toBeNull();
    expect(result.server.hostname).toBeNull();
  });

  it('registers with a private-key credential and reports credentialType ssh_private_key', async () => {
    fixture = await startServiceFixture();

    const result = await registerFixtureServer(fixture, {
      credential: { kind: 'private_key', privateKey: VALID_PRIVATE_KEY },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.server.credentialType).toBe('ssh_private_key');
  });

  it('stores a non-plaintext encrypted_value with key_version equal to currentKeyVersion', async () => {
    fixture = await startServiceFixture();
    const password = freshPassword();

    const result = await registerFixtureServer(fixture, { credential: { kind: 'password', password } });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [credentialRow] = await fixture.db
      .select()
      .from(credentials)
      .where(eq(credentials.type, 'ssh_password'));
    expect(credentialRow).toBeDefined();
    expect(credentialRow?.encryptedValue).not.toBeNull();
    expect(credentialRow?.encryptedValue).not.toContain(password);
    // Empty table before this call, so currentKeyVersion() must be 1.
    expect(credentialRow?.keyVersion).toBe(1);
  });

  it('never leaks the raw password or private key text in the result', async () => {
    fixture = await startServiceFixture();
    const password = freshPassword();

    const passwordResult = await registerFixtureServer(fixture, { credential: { kind: 'password', password } });
    const keyResult = await registerFixtureServer(fixture, {
      credential: { kind: 'private_key', privateKey: VALID_PRIVATE_KEY },
    });

    const passwordJson = JSON.stringify(passwordResult);
    const keyJson = JSON.stringify(keyResult);
    expect(passwordJson).not.toContain(password);
    expect(keyJson).not.toContain('BEGIN OPENSSH PRIVATE KEY');
    expect(keyJson).not.toContain(VALID_PRIVATE_KEY);
  });

  it('never includes credentialId or encryptedValue on the returned server', async () => {
    fixture = await startServiceFixture();

    const result = await registerFixtureServer(fixture);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const keys = Object.keys(result.server);
    expect(keys).not.toContain('credentialId');
    expect(keys).not.toContain('encryptedValue');
  });

  it('writes exactly one server.created activity event with D-16 metadata', async () => {
    fixture = await startServiceFixture();
    const name = uniqueName();
    const host = uniqueHost();

    const result = await registerFixtureServer(fixture, {
      name,
      host,
      sshPort: 2200,
      sshUser: 'deployer',
      credential: { kind: 'password', password: freshPassword() },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rows = await fixture.db
      .select()
      .from(activityEvents)
      .where(eq(activityEvents.entityId, result.server.id));

    expect(rows).toHaveLength(1);
    const [event] = rows;
    expect(event?.action).toBe('server.created');
    expect(event?.entityType).toBe('server');
    expect(event?.outcome).toBe('success');
    expect(event?.metadata).toEqual({
      name,
      host,
      sshPort: 2200,
      sshUser: 'deployer',
      credentialType: 'ssh_password',
    });
  });

  it('attributes the event to a user actor (D-17)', async () => {
    fixture = await startServiceFixture();
    const userId = randomUUID();

    const result = await registerFixtureServer(fixture, { actor: { type: 'user', id: userId } });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [event] = await fixture.db
      .select()
      .from(activityEvents)
      .where(eq(activityEvents.entityId, result.server.id));
    expect(event?.actorType).toBe('user');
    expect(event?.actorId).toBe(userId);
  });

  it('attributes the event to a system actor with a null actorId (D-17)', async () => {
    fixture = await startServiceFixture();

    const result = await registerFixtureServer(fixture, { actor: { type: 'system' } });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [event] = await fixture.db
      .select()
      .from(activityEvents)
      .where(eq(activityEvents.entityId, result.server.id));
    expect(event?.actorType).toBe('system');
    expect(event?.actorId).toBeNull();
  });

  it('rejects an uppercase name with VALIDATION_FAILED', async () => {
    fixture = await startServiceFixture();

    const result = await registerFixtureServer(fixture, { name: 'SRV-1' });

    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
  });

  it('rejects a second registration of the same name (case-insensitive) with NAME_TAKEN', async () => {
    fixture = await startServiceFixture();
    const name = 'srv-1';

    const first = await registerFixtureServer(fixture, { name });
    expect(first.ok).toBe(true);

    const second = await registerFixtureServer(fixture, { name: name.toUpperCase() === name ? name : 'srv-1' });
    expect(second).toMatchObject({ ok: false, code: 'NAME_TAKEN' });
  });

  it('rejects a different name at an already-used host:port with HOST_TAKEN', async () => {
    fixture = await startServiceFixture();
    const host = uniqueHost();

    const first = await registerFixtureServer(fixture, { host, sshPort: 22 });
    expect(first.ok).toBe(true);

    const second = await registerFixtureServer(fixture, { host, sshPort: 22 });
    expect(second).toMatchObject({ ok: false, code: 'HOST_TAKEN' });
  });

  it('accepts the same host with a different sshPort', async () => {
    fixture = await startServiceFixture();
    const host = uniqueHost();

    const first = await registerFixtureServer(fixture, { host, sshPort: 22 });
    expect(first.ok).toBe(true);

    const second = await registerFixtureServer(fixture, { host, sshPort: 2222 });
    expect(second.ok).toBe(true);
  });

  it('rejects an invalid (too-small) private key with INVALID_CREDENTIAL', async () => {
    fixture = await startServiceFixture();

    const result = await registerFixtureServer(fixture, {
      credential: { kind: 'private_key', privateKey: TOO_SMALL_PRIVATE_KEY },
    });

    expect(result).toMatchObject({ ok: false, code: 'INVALID_CREDENTIAL' });
  });

  it('rejects an invalid host with VALIDATION_FAILED', async () => {
    fixture = await startServiceFixture();

    const result = await registerFixtureServer(fixture, { host: 'bad;host' });

    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
  });

  it('leaves no orphan rows and no new activity event after a NAME_TAKEN failure', async () => {
    fixture = await startServiceFixture();
    const name = 'srv-collision';
    const first = await registerFixtureServer(fixture, { name });
    expect(first.ok).toBe(true);

    const before = await tableCounts(fixture);
    const second = await registerFixtureServer(fixture, { name });
    expect(second.ok).toBe(false);
    const after = await tableCounts(fixture);

    expect(after).toEqual(before);
  });

  it('leaves no orphan rows and no new activity event after an INVALID_CREDENTIAL failure', async () => {
    fixture = await startServiceFixture();

    const before = await tableCounts(fixture);
    const result = await registerFixtureServer(fixture, {
      credential: { kind: 'private_key', privateKey: TOO_SMALL_PRIVATE_KEY },
    });
    expect(result.ok).toBe(false);
    const after = await tableCounts(fixture);

    expect(after).toEqual(before);
  });

  it('leaves no orphan rows and no new activity event after a VALIDATION_FAILED failure', async () => {
    fixture = await startServiceFixture();

    const before = await tableCounts(fixture);
    const result = await registerFixtureServer(fixture, { host: 'bad;host' });
    expect(result.ok).toBe(false);
    const after = await tableCounts(fixture);

    expect(after).toEqual(before);
  });
});
