import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { revealSecret } from '@noodara/domain/security';
import type { Database } from '../db/client.js';
import { activityEvents } from '../db/schema/activity-events.js';
import { credentials } from '../db/schema/credentials.js';
import { services } from '../db/schema/services.js';
import { decryptCredentialEnvelope } from './credential-store.js';
import {
  disableWebhook,
  enableWebhook,
  generateHookId,
  generateWebhookSecret,
  getWebhookConfig,
  resolveWebhookSecret,
  rotateWebhookSecret,
  WEBHOOK_HOOK_ID_BYTES,
  WEBHOOK_SECRET_BYTES,
  WebhookOriginError,
  webhookPayloadUrl,
  webhookPublicOrigin,
  type RandomBytes,
  type WebhookConfigDeps,
} from './webhook-config.js';

const PROJECT_ID = '0192f1a4-7b3c-7d2e-8f00-0123456789ab';
const SERVICE_ID = '0192f1a4-7b3c-7d2e-8f00-012345678901';
const ORIGIN = 'https://noodara.example.com';
const ACTOR = { type: 'user', id: 'user-1' } as const;
const TARGET = { actor: ACTOR, projectId: PROJECT_ID, serviceId: SERVICE_ID };
const MASTER_KEYS = { current: randomBytes(32) };
const HOOK_ID_SHAPE = /^[A-Za-z0-9_-]{22,64}$/;

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------
// An in-memory database with snapshot transactions: a transaction works on a draft that replaces
// the committed state only when its callback resolves, like a single-statement reader under
// READ COMMITTED. `duringUpdate` runs a reader against the committed state mid-transaction.
// ---------------------------------------------------------------------------------------------

interface ServiceRow {
  id: string;
  projectId: string;
  sourceType: 'git' | 'image';
  webhookHookId: string | null;
  webhookSecretCredentialId: string | null;
}

interface CredentialRow {
  id: string;
  type: string;
  encryptedValue: string;
  keyVersion: number;
}

interface State {
  service: ServiceRow | null;
  credentials: Map<string, CredentialRow>;
  activity: Record<string, unknown>[];
}

function clone(state: State): State {
  return {
    service: state.service === null ? null : { ...state.service },
    credentials: new Map([...state.credentials].map(([id, row]) => [id, { ...row }])),
    activity: [...state.activity],
  };
}

function fakeDb(service: ServiceRow | null) {
  let committed: State = { service, credentials: new Map(), activity: [] };
  const ops: string[] = [];
  let nextId = 0;
  let duringUpdate: (() => Promise<void>) | undefined;

  function handle(read: () => State, inTx: boolean): unknown {
    const query = (kind: string, table: unknown) => {
      const calls: { name: string; args: unknown[] }[] = [];
      const run = async (): Promise<unknown[]> => {
        const state = read();
        const scope = inTx ? 'tx' : 'db';
        const name = (name: string) => calls.find((call) => call.name === name);
        if (kind === 'select') {
          const from = name('from')?.args[0];
          if (name('innerJoin')) {
            ops.push(`${scope}:select:join`);
            const svc = state.service;
            const cred = svc?.webhookSecretCredentialId ? state.credentials.get(svc.webhookSecretCredentialId) : undefined;
            if (!svc?.webhookHookId || cred?.type !== 'webhook_secret') return [];
            return [{ serviceId: svc.id, encryptedValue: cred.encryptedValue, keyVersion: cred.keyVersion }];
          }
          if (from === credentials) return [{ maxVersion: 1 }];
          ops.push(`${scope}:select:services`);
          return state.service ? [{ ...state.service }] : [];
        }
        if (kind === 'insert') {
          const values = name('values')?.args[0] as Record<string, unknown>;
          if (table === credentials) {
            ops.push(`${scope}:insert:credentials`);
            const id = `cred-${(nextId += 1).toString()}`;
            state.credentials.set(id, {
              id,
              type: String(values.type),
              encryptedValue: String(values.encryptedValue),
              keyVersion: Number(values.keyVersion),
            });
            return [{ id }];
          }
          if (table === activityEvents) {
            ops.push(`${scope}:insert:activity`);
            state.activity.push(values);
            return [{ id: `act-${state.activity.length.toString()}` }];
          }
          throw new Error('unexpected insert');
        }
        if (kind === 'update' && table === services) {
          ops.push(`${scope}:update:services`);
          if (state.service) Object.assign(state.service, name('set')?.args[0]);
          if (inTx && duringUpdate) await duringUpdate();
          return [];
        }
        if (kind === 'delete' && table === credentials) {
          ops.push(`${scope}:delete:credentials`);
          for (const id of [...state.credentials.keys()]) {
            if (state.service?.webhookSecretCredentialId !== id) state.credentials.delete(id);
          }
          return [];
        }
        throw new Error(`unexpected ${kind}`);
      };
      const proxy: unknown = new Proxy(
        {},
        {
          get(_target, prop) {
            if (prop === 'then') {
              return (ok: (value: unknown) => void, fail: (error: unknown) => void) => {
                run().then(ok, fail);
              };
            }
            return (...args: unknown[]) => {
              calls.push({ name: String(prop), args });
              return proxy;
            };
          },
        },
      );
      return proxy;
    };
    return {
      select: () => query('select', undefined),
      insert: (table: unknown) => query('insert', table),
      update: (table: unknown) => query('update', table),
      delete: (table: unknown) => query('delete', table),
      transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
        const draft = clone(committed);
        const result = await fn(handle(() => draft, true));
        committed = draft;
        return result;
      },
    };
  }

  return {
    db: handle(() => committed, false) as Database,
    ops,
    state: () => committed,
    setDuringUpdate(fn: (() => Promise<void>) | undefined) {
      duringUpdate = fn;
    },
  };
}

function gitService(overrides: Partial<ServiceRow> = {}): ServiceRow {
  return {
    id: SERVICE_ID,
    projectId: PROJECT_ID,
    sourceType: 'git',
    webhookHookId: null,
    webhookSecretCredentialId: null,
    ...overrides,
  };
}

function depsFor(db: Database, random?: RandomBytes): WebhookConfigDeps {
  return {
    db,
    now: () => new Date('2026-10-16T10:00:00.000Z'),
    masterKeys: () => Promise.resolve(MASTER_KEYS),
    publicOrigin: ORIGIN,
    ...(random !== undefined ? { randomBytes: random } : {}),
  };
}

function storedSecret(fake: ReturnType<typeof fakeDb>): string | null {
  const id = fake.state().service?.webhookSecretCredentialId;
  const row = id ? fake.state().credentials.get(id) : undefined;
  return row ? decryptCredentialEnvelope(row, MASTER_KEYS) : null;
}

// ---------------------------------------------------------------------------------------------

describe('generation (H1)', () => {
  it('draws a 32-byte secret and a 24-byte hook id from the random source', () => {
    const sizes: number[] = [];
    const random: RandomBytes = (size) => {
      sizes.push(size);
      return Buffer.alloc(size, 0xab);
    };
    const hookId = generateHookId(random);
    const secret = generateWebhookSecret(random);
    expect(sizes).toEqual([WEBHOOK_HOOK_ID_BYTES, WEBHOOK_SECRET_BYTES]);
    expect(WEBHOOK_SECRET_BYTES).toBe(32);
    expect(WEBHOOK_HOOK_ID_BYTES * 8).toBeGreaterThanOrEqual(128);
    expect(hookId).toBe(Buffer.alloc(24, 0xab).toString('base64url'));
    expect(hookId).toMatch(HOOK_ID_SHAPE);
    expect(revealSecret(secret)).toBe('ab'.repeat(32));
  });

  it('uses node:crypto by default, never Math.random, and keeps the secret out of inspect/JSON', () => {
    const mathRandom = vi.spyOn(Math, 'random');
    const ids = new Set(Array.from({ length: 50 }, () => generateHookId()));
    const secret = generateWebhookSecret();
    expect(ids.size).toBe(50);
    expect(mathRandom).not.toHaveBeenCalled();
    expect(revealSecret(secret)).toMatch(/^[0-9a-f]{64}$/);
    expect(inspect(secret)).not.toContain(revealSecret(secret));
    expect(JSON.stringify({ secret })).not.toContain(revealSecret(secret));
  });

  it('never derives the hook id from the service: two enables of one service get unrelated ids', async () => {
    const mathRandom = vi.spyOn(Math, 'random');
    const fake = fakeDb(gitService());
    const deps = depsFor(fake.db);
    const first = await enableWebhook(deps, TARGET);
    await disableWebhook(deps, TARGET);
    const second = await enableWebhook(deps, TARGET);
    if (!first.ok || !second.ok) throw new Error('enable failed');
    const idOf = (url: string) => url.slice(url.lastIndexOf('/') + 1);
    expect(idOf(first.webhook.payloadUrl)).not.toBe(idOf(second.webhook.payloadUrl));
    for (const id of [idOf(first.webhook.payloadUrl), idOf(second.webhook.payloadUrl)]) {
      expect(id).toMatch(HOOK_ID_SHAPE);
      expect(id).not.toContain(SERVICE_ID.replace(/-/g, '').slice(0, 8));
    }
    expect(mathRandom).not.toHaveBeenCalled();
  });
});

describe('webhookPublicOrigin / webhookPayloadUrl (H3)', () => {
  it('keeps the origin of an http or https public URL', () => {
    expect(webhookPublicOrigin('https://noodara.example.com/some/path?x=1')).toBe('https://noodara.example.com');
    expect(webhookPublicOrigin('http://10.0.0.5:3000')).toBe('http://10.0.0.5:3000');
    expect(webhookPayloadUrl('http://10.0.0.5:3000', 'abc')).toBe('http://10.0.0.5:3000/webhooks/github/abc');
  });

  it.each(['ftp://noodara.example.com', 'javascript:alert(1)', 'noodara.example.com', '/relative', '', 'file:///etc/passwd'])(
    'rejects %j',
    (value) => {
      expect(() => webhookPublicOrigin(value)).toThrow(WebhookOriginError);
    },
  );

  it('rejects userinfo without quoting it', () => {
    const canary = `pw${randomBytes(4).toString('hex')}`;
    let error: unknown;
    try {
      webhookPublicOrigin(`https://admin:${canary}@noodara.example.com`);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(WebhookOriginError);
    expect((error as Error).message).not.toContain(canary);
  });
});

describe('enableWebhook (A1, A3, A4, H2)', () => {
  it('stores the secret encrypted, returns it once with the payload URL and records an event without it', async () => {
    const fake = fakeDb(gitService());
    const result = await enableWebhook(depsFor(fake.db), TARGET);
    if (!result.ok) throw new Error(result.code);
    const secret = revealSecret(result.webhook.secret);
    const service = fake.state().service;
    expect(service?.webhookHookId).toMatch(HOOK_ID_SHAPE);
    expect(result.webhook.payloadUrl).toBe(`${ORIGIN}/webhooks/github/${String(service?.webhookHookId)}`);

    const [row] = [...fake.state().credentials.values()];
    expect(row?.type).toBe('webhook_secret');
    expect(row?.encryptedValue).not.toContain(secret);
    expect(storedSecret(fake)).toBe(secret);

    expect(fake.state().activity).toHaveLength(1);
    expect(fake.state().activity[0]).toMatchObject({
      action: 'service.updated',
      entityId: SERVICE_ID,
      actorId: ACTOR.id,
      metadata: { changedFields: ['webhook'], requiresRedeploy: false, credentialReplaced: false },
    });
    const activity = JSON.stringify(fake.state().activity);
    expect(activity).not.toContain(secret);
    expect(activity).not.toContain(String(service?.webhookHookId));
    expect(fake.ops.filter((op) => op.startsWith('db:'))).toEqual([]);
  });

  it('answers WEBHOOK_ALREADY_ENABLED on a second enable and never rotates the secret silently', async () => {
    const fake = fakeDb(gitService());
    const deps = depsFor(fake.db);
    const first = await enableWebhook(deps, TARGET);
    if (!first.ok) throw new Error(first.code);
    const hookId = fake.state().service?.webhookHookId;
    const second = await enableWebhook(deps, TARGET);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe('WEBHOOK_ALREADY_ENABLED');
    expect(JSON.stringify(second)).not.toContain(revealSecret(first.webhook.secret));
    expect(fake.state().service?.webhookHookId).toBe(hookId);
    expect(storedSecret(fake)).toBe(revealSecret(first.webhook.secret));
    expect(fake.state().credentials.size).toBe(1);
    expect(fake.state().activity).toHaveLength(1);
  });

  it('refuses an image-source service with WEBHOOK_SOURCE_NOT_GIT and writes nothing', async () => {
    const fake = fakeDb(gitService({ sourceType: 'image' }));
    const result = await enableWebhook(depsFor(fake.db), TARGET);
    expect(result).toMatchObject({ ok: false, code: 'WEBHOOK_SOURCE_NOT_GIT' });
    expect(fake.state().credentials.size).toBe(0);
    expect(fake.state().activity).toHaveLength(0);
  });

  it('answers NOT_FOUND for a service outside the project', async () => {
    const fake = fakeDb(null);
    expect(await enableWebhook(depsFor(fake.db), TARGET)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('replaces a hook id left without a secret (fails closed, counts as disabled)', async () => {
    const fake = fakeDb(gitService({ webhookHookId: 'x'.repeat(32) }));
    expect(await getWebhookConfig(depsFor(fake.db), PROJECT_ID, SERVICE_ID)).toStrictEqual({ enabled: false, payloadUrl: null });
    const result = await enableWebhook(depsFor(fake.db), TARGET);
    expect(result.ok).toBe(true);
    expect(fake.state().service?.webhookHookId).not.toBe('x'.repeat(32));
  });
});

describe('getWebhookConfig (A1)', () => {
  it('returns enabled and the payload URL only, never the secret', async () => {
    const fake = fakeDb(gitService());
    const enabled = await enableWebhook(depsFor(fake.db), TARGET);
    if (!enabled.ok) throw new Error(enabled.code);
    const view = await getWebhookConfig(depsFor(fake.db), PROJECT_ID, SERVICE_ID);
    expect(view).toStrictEqual({ enabled: true, payloadUrl: enabled.webhook.payloadUrl });
    expect(JSON.stringify(view)).not.toContain(revealSecret(enabled.webhook.secret));
    expect(await getWebhookConfig(depsFor(fakeDb(null).db), PROJECT_ID, SERVICE_ID)).toBeNull();
  });
});

describe('rotateWebhookSecret (A2, H1)', () => {
  it('keeps the hook id, replaces the secret and deletes the old credential row', async () => {
    const fake = fakeDb(gitService());
    const deps = depsFor(fake.db);
    const first = await enableWebhook(deps, TARGET);
    if (!first.ok) throw new Error(first.code);
    const hookId = String(fake.state().service?.webhookHookId);
    const oldCredentialId = fake.state().service?.webhookSecretCredentialId;

    const rotated = await rotateWebhookSecret(deps, TARGET);
    if (!rotated.ok) throw new Error(rotated.code);
    expect(rotated.webhook.payloadUrl).toBe(first.webhook.payloadUrl);
    expect(revealSecret(rotated.webhook.secret)).not.toBe(revealSecret(first.webhook.secret));
    expect(fake.state().service?.webhookHookId).toBe(hookId);
    expect(fake.state().service?.webhookSecretCredentialId).not.toBe(oldCredentialId);
    expect(fake.state().credentials.has(String(oldCredentialId))).toBe(false);
    expect(fake.state().credentials.size).toBe(1);

    const resolved = await resolveWebhookSecret(deps, hookId);
    expect(resolved && revealSecret(resolved.secret)).toBe(revealSecret(rotated.webhook.secret));
    expect(fake.state().activity.at(-1)).toMatchObject({
      metadata: { changedFields: ['webhookSecret'], requiresRedeploy: false, credentialReplaced: true },
    });
  });

  it('is atomic: a delivery resolved mid-rotation sees the old secret, one after it the new one', async () => {
    const fake = fakeDb(gitService());
    const deps = depsFor(fake.db);
    const first = await enableWebhook(deps, TARGET);
    if (!first.ok) throw new Error(first.code);
    const hookId = String(fake.state().service?.webhookHookId);
    const seen: (string | null)[] = [];
    fake.setDuringUpdate(async () => {
      const mid = await resolveWebhookSecret(deps, hookId);
      seen.push(mid ? revealSecret(mid.secret) : null);
    });

    const rotated = await rotateWebhookSecret(deps, TARGET);
    fake.setDuringUpdate(undefined);
    if (!rotated.ok) throw new Error(rotated.code);
    const after = await resolveWebhookSecret(deps, hookId);

    expect(seen).toEqual([revealSecret(first.webhook.secret)]);
    expect(after && revealSecret(after.secret)).toBe(revealSecret(rotated.webhook.secret));
    // Every write of the rotation ran inside the transaction; the readers ran outside it.
    expect(fake.ops.filter((op) => op.startsWith('db:') && !op.includes(':select:'))).toEqual([]);
    expect(fake.ops.filter((op) => op === 'db:select:join')).toHaveLength(2);
  });

  it('answers WEBHOOK_NOT_ENABLED when disabled and WEBHOOK_SOURCE_NOT_GIT for an image service', async () => {
    expect(await rotateWebhookSecret(depsFor(fakeDb(gitService()).db), TARGET)).toMatchObject({
      ok: false,
      code: 'WEBHOOK_NOT_ENABLED',
    });
    expect(await rotateWebhookSecret(depsFor(fakeDb(gitService({ sourceType: 'image' })).db), TARGET)).toMatchObject({
      ok: false,
      code: 'WEBHOOK_SOURCE_NOT_GIT',
    });
  });
});

describe('disableWebhook (A2, H2)', () => {
  it('clears the hook id, deletes the credential and resolves the old id like an unknown one', async () => {
    const fake = fakeDb(gitService());
    const deps = depsFor(fake.db);
    const enabled = await enableWebhook(deps, TARGET);
    if (!enabled.ok) throw new Error(enabled.code);
    const hookId = String(fake.state().service?.webhookHookId);

    const result = await disableWebhook(deps, TARGET);
    expect(result).toStrictEqual({ ok: true, webhook: { enabled: false, payloadUrl: null } });
    expect(fake.state().service).toMatchObject({ webhookHookId: null, webhookSecretCredentialId: null });
    expect(fake.state().credentials.size).toBe(0);
    expect(await resolveWebhookSecret(deps, hookId)).toBeNull();
    expect(await resolveWebhookSecret(deps, generateHookId())).toBeNull();
    expect(fake.state().activity.at(-1)).toMatchObject({
      metadata: { changedFields: ['webhook'], requiresRedeploy: false, credentialReplaced: true },
    });
  });

  it('is a no-op without an event when already disabled', async () => {
    const fake = fakeDb(gitService());
    expect(await disableWebhook(depsFor(fake.db), TARGET)).toMatchObject({ ok: true, webhook: { enabled: false } });
    expect(fake.state().activity).toHaveLength(0);
    expect(await disableWebhook(depsFor(fakeDb(null).db), TARGET)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });
});

describe('resolveWebhookSecret (H2)', () => {
  it.each(['', 'short', 'x'.repeat(65), 'has space in it and is long enough', '../../etc/passwd/aaaaaaaaaaaaaa'])(
    'answers null for the malformed hook id %j without a query',
    async (hookId) => {
      const fake = fakeDb(gitService());
      expect(await resolveWebhookSecret(depsFor(fake.db), hookId)).toBeNull();
      expect(fake.ops).toEqual([]);
    },
  );
});
