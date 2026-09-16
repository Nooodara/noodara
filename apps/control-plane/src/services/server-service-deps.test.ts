// D-17: RED for `ServiceActor` + `resolveServerServicesDeps`. Runs under the `apps` Vitest
// project, which already injects fixture values for NOODARA_MASTER_KEY / BETTER_AUTH_SECRET /
// DATABASE_URL / REDIS_URL / NOODARA_PUBLIC_URL (vitest.config.ts), so importing env.js at module
// load time is safe here.
import { describe, expect, it } from 'vitest';
import { appRedactor } from '../activity/redaction.js';
import { decodeMasterKey } from '../boot/master-key.js';
import { env } from '../env.js';
import { resolveServerServicesDeps, type ServiceActor, type ServerServicesDeps } from './server-service-deps.js';

// A fake `db` override so no test ever opens a real Postgres pool.
const fakeDb = {} as ServerServicesDeps['db'];

describe('ServiceActor (D-17)', () => {
  it('accepts a user actor', () => {
    const actor: ServiceActor = { type: 'user', id: 'user-1' };
    expect(actor.type).toBe('user');
  });

  it('accepts a system actor', () => {
    const actor: ServiceActor = { type: 'system' };
    expect(actor.type).toBe('system');
  });
});

describe('resolveServerServicesDeps', () => {
  it('returns overrides unchanged when supplied (fake SshPort)', async () => {
    const fakeSsh: ServerServicesDeps['ssh'] = {
      connect: async () => ({ ok: false, errorCode: 'AUTH_FAILED', message: 'fake', attempts: 1 }),
    };

    const deps = await resolveServerServicesDeps({ db: fakeDb, ssh: fakeSsh });

    expect(deps.ssh).toBe(fakeSsh);
    expect(deps.db).toBe(fakeDb);
  });

  it('derives timeouts from env when not overridden', async () => {
    const deps = await resolveServerServicesDeps({ db: fakeDb });

    expect(deps.timeouts).toEqual({
      connectMs: env.NOODARA_SSH_CONNECT_TIMEOUT_MS,
      commandMs: env.NOODARA_SSH_COMMAND_TIMEOUT_MS,
      discoveryMs: env.NOODARA_SSH_DISCOVERY_TIMEOUT_MS,
    });
  });

  it('an overridden timeouts value wins over the env-derived default', async () => {
    const timeouts = { connectMs: 1, commandMs: 2, discoveryMs: 3 };
    const deps = await resolveServerServicesDeps({ db: fakeDb, timeouts });

    expect(deps.timeouts).toBe(timeouts);
  });

  it('returns the process appRedactor singleton, never a fresh Redactor', async () => {
    const deps = await resolveServerServicesDeps({ db: fakeDb });

    expect(deps.redactor).toBe(appRedactor);
  });

  it('an overridden redactor wins over the appRedactor default', async () => {
    const fakeRedactor = { register: () => undefined, release: () => undefined, redact: <T>(v: T) => v };
    const deps = await resolveServerServicesDeps({ db: fakeDb, redactor: fakeRedactor });

    expect(deps.redactor).toBe(fakeRedactor);
  });

  it('masterKeys.current equals decodeMasterKey(env.NOODARA_MASTER_KEY)', async () => {
    const deps = await resolveServerServicesDeps({ db: fakeDb });

    expect(deps.masterKeys.current).toEqual(decodeMasterKey(env.NOODARA_MASTER_KEY));
  });

  it('omits masterKeys.previous entirely when NOODARA_MASTER_KEY_PREVIOUS is unset', async () => {
    // The `apps` vitest project's fixture env (vitest.config.ts) never sets
    // NOODARA_MASTER_KEY_PREVIOUS, so this reflects the real default resolution path.
    expect(env.NOODARA_MASTER_KEY_PREVIOUS).toBeUndefined();

    const deps = await resolveServerServicesDeps({ db: fakeDb });

    expect('previous' in deps.masterKeys).toBe(false);
  });

  it('an overridden masterKeys wins over the env-derived default', async () => {
    const masterKeys = { current: Buffer.alloc(32, 7) };
    const deps = await resolveServerServicesDeps({ db: fakeDb, masterKeys });

    expect(deps.masterKeys).toBe(masterKeys);
  });

  it('now defaults to a function returning a Date', async () => {
    const deps = await resolveServerServicesDeps({ db: fakeDb });

    expect(deps.now()).toBeInstanceOf(Date);
  });

  it('an overridden now wins over the default clock', async () => {
    const fixed = new Date('2020-01-01T00:00:00Z');
    const now = () => fixed;
    const deps = await resolveServerServicesDeps({ db: fakeDb, now });

    expect(deps.now()).toBe(fixed);
  });
});
