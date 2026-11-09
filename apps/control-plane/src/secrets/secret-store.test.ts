// SEC-04 (23-01): unit tests for the secret envelope boundary. Keys and values are generated per
// run; the database-touching functions run against a minimal recording fake here and against real
// Postgres in tests/integration/env/secret-store.test.ts.
import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { SQL } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  createRedactor,
  encryptSecret,
  revealSecret,
  secretValue,
} from '@noodara/domain/security';
import {
  createSecret,
  decryptForDeploy,
  encodeSecret,
  HINT_MIN_VALUE_LENGTH,
  isInScopeChain,
  leaseSecrets,
  MIN_REDACTABLE_SECRET_LENGTH,
  openSecretEnvelope,
  replaceSecret,
  SecretStoreError,
  secretHint,
  type ScopeChain,
  type SecretStoreHandle,
} from './secret-store.js';

const CURRENT = randomBytes(32);
const PREVIOUS = randomBytes(32);
const OTHER = randomBytes(32);

const CHAIN: ScopeChain = {
  projectId: '00000000-0000-7000-8000-00000000000a',
  environmentId: '00000000-0000-7000-8000-00000000000b',
  serviceId: '00000000-0000-7000-8000-00000000000c',
};
const FOREIGN_PROJECT = '00000000-0000-7000-8000-0000000000ff';

// Lowercase hex: base64url could randomly form `sk-…`/`ghp_…`, which the redactor masks structurally.
function canary(length: number): string {
  return randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
}

function appSecret(raw: string) {
  return secretValue(raw, 'app_secret');
}

interface StoredRow {
  id: string;
  scope: 'project' | 'environment' | 'service';
  projectId: string;
  environmentId: string | null;
  serviceId: string | null;
  name: string;
  encryptedValue: string;
  keyVersion: number;
  version: number;
  hint: string;
  createdAt: Date;
  updatedAt: Date;
}

function storedRow(overrides: Partial<StoredRow> & { raw?: string } = {}): StoredRow {
  const { raw = canary(32), ...rest } = overrides;
  return {
    id: rest.id ?? '00000000-0000-7000-8000-000000000001',
    scope: 'project',
    projectId: CHAIN.projectId,
    environmentId: null,
    serviceId: null,
    name: 'api_token',
    encryptedValue: encryptSecret(raw, { key: CURRENT, version: 1 }),
    keyVersion: 1,
    version: 1,
    hint: secretHint(raw),
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...rest,
  };
}

/** A recording fake of the few Drizzle builder calls secret-store makes; `rows` is what every
 *  select/insert/update resolves to (the fake ignores WHERE clauses on purpose). */
function fakeHandle(rows: StoredRow[], maxKeyVersion: number | null = 1) {
  const calls: { inserted?: Record<string, unknown>; updated?: Record<string, unknown>; locked: boolean } = {
    locked: false,
  };
  const chain = (result: unknown) => {
    const builder: Record<string, unknown> = {};
    for (const method of ['from', 'where', 'values', 'set']) {
      builder[method] = (arg: unknown) => {
        if (method === 'values') calls.inserted = arg as Record<string, unknown>;
        if (method === 'set') calls.updated = arg as Record<string, unknown>;
        return builder;
      };
    }
    builder.for = () => {
      calls.locked = true;
      return builder;
    };
    builder.returning = () => Promise.resolve(result);
    builder.then = (resolve: (value: unknown) => void, reject: (reason: unknown) => void) =>
      Promise.resolve(result).then(resolve, reject);
    return builder;
  };
  const handle = {
    execute: () => Promise.resolve({ rows: [{ v: maxKeyVersion }] }),
    select: () => chain(rows),
    insert: () => chain(rows),
    update: () => chain(rows),
    transaction: (cb: (tx: unknown) => Promise<unknown>) => cb(handle),
  };
  return { handle: handle as unknown as SecretStoreHandle, calls };
}

describe('secretHint', () => {
  it('is the last 4 characters only when the value has at least 16 characters', () => {
    const long = canary(HINT_MIN_VALUE_LENGTH);
    expect(secretHint(long)).toBe(long.slice(-4));
    expect(secretHint(long)).toHaveLength(4);
    expect(secretHint(canary(HINT_MIN_VALUE_LENGTH - 1))).toBe('');
    expect(secretHint('abc')).toBe('');
  });
});

describe('encodeSecret', () => {
  it('encrypts an app_secret under the key version and computes the hint', () => {
    const raw = canary(40);
    const encoded = encodeSecret(appSecret(raw), { key: CURRENT, version: 3 });
    expect(encoded.keyVersion).toBe(3);
    expect(encoded.encryptedValue.startsWith('v3:')).toBe(true);
    expect(encoded.encryptedValue).not.toContain(raw);
    expect(encoded.hint).toBe(raw.slice(-4));
  });

  it('refuses a value of another kind or an empty value with SECRET_VALUE_INVALID', () => {
    const key = { key: CURRENT, version: 1 };
    expect(() => encodeSecret(secretValue(canary(20), 'ssh_password'), key)).toThrow(SecretStoreError);
    expect(() => encodeSecret(appSecret(''), key)).toThrow(
      expect.objectContaining({ code: 'SECRET_VALUE_INVALID' }) as Error,
    );
  });
});

describe('openSecretEnvelope', () => {
  it('returns SecretValue(app_secret) that never prints the value', () => {
    const raw = canary(24);
    const value = openSecretEnvelope(storedRow({ raw }), { current: CURRENT });
    expect(value.kind).toBe('app_secret');
    expect(revealSecret(value)).toBe(raw);
    expect(String(value)).toBe('[REDACTED:app_secret]');
    expect(JSON.stringify({ value })).not.toContain(raw);
    expect(inspect({ value })).not.toContain(raw);
  });

  it('falls back to the previous key during the rotation window', () => {
    const raw = canary(24);
    const row = storedRow({ encryptedValue: encryptSecret(raw, { key: PREVIOUS, version: 1 }) });
    expect(revealSecret(openSecretEnvelope(row, { current: CURRENT, previous: PREVIOUS }))).toBe(raw);
  });

  it.each([
    ['wrong key', () => storedRow({ encryptedValue: encryptSecret(canary(24), { key: OTHER, version: 1 }) }), 'SECRET_TAMPERED'],
    [
      'tampered tag',
      () => {
        const parts = encryptSecret(canary(24), { key: CURRENT, version: 1 }).split(':');
        return storedRow({ encryptedValue: [...parts.slice(0, 3), randomBytes(16).toString('base64')].join(':') });
      },
      'SECRET_TAMPERED',
    ],
    ['malformed blob', () => storedRow({ encryptedValue: 'not-a-blob' }), 'SECRET_MALFORMED'],
    ['unknown key version', () => storedRow({ keyVersion: 2 }), 'SECRET_KEY_UNKNOWN'],
  ])('maps %s to a named store error without the value or ciphertext', (_label, build, code) => {
    const row = build();
    let caught: unknown;
    try {
      openSecretEnvelope(row, { current: CURRENT, previous: PREVIOUS });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SecretStoreError);
    const error = caught as SecretStoreError;
    expect(error.code).toBe(code);
    expect(error.secretId).toBe(row.id);
    expect(error.cause).toBeUndefined();
    const serialized = JSON.stringify(error) + error.message + inspect(error);
    expect(serialized).not.toContain(row.encryptedValue);
    expect(serialized).not.toContain(CURRENT.toString('base64'));
  });
});

describe('isInScopeChain (H1)', () => {
  it('accepts the chain project, environment and service owners', () => {
    expect(isInScopeChain({ scope: 'project', projectId: CHAIN.projectId, environmentId: null, serviceId: null }, CHAIN)).toBe(true);
    expect(
      isInScopeChain({ scope: 'environment', projectId: CHAIN.projectId, environmentId: CHAIN.environmentId, serviceId: null }, CHAIN),
    ).toBe(true);
    expect(
      isInScopeChain({ scope: 'service', projectId: CHAIN.projectId, environmentId: null, serviceId: CHAIN.serviceId }, CHAIN),
    ).toBe(true);
  });

  it('refuses a foreign project, a sibling environment and a sibling service', () => {
    expect(isInScopeChain({ scope: 'project', projectId: FOREIGN_PROJECT, environmentId: null, serviceId: null }, CHAIN)).toBe(false);
    expect(
      isInScopeChain({ scope: 'environment', projectId: CHAIN.projectId, environmentId: FOREIGN_PROJECT, serviceId: null }, CHAIN),
    ).toBe(false);
    expect(
      isInScopeChain({ scope: 'service', projectId: CHAIN.projectId, environmentId: null, serviceId: FOREIGN_PROJECT }, CHAIN),
    ).toBe(false);
    expect(
      isInScopeChain({ scope: 'service', projectId: FOREIGN_PROJECT, environmentId: null, serviceId: CHAIN.serviceId }, CHAIN),
    ).toBe(false);
  });
});

describe('leaseSecrets (H2)', () => {
  it('redacts a 64-char value wherever it appears and releases it after the attempt', () => {
    const redactor = createRedactor();
    const long = canary(64);
    const lease = leaseSecrets(new Map([['a', appSecret(long)]]), redactor);
    const line = `start ${long} middle ${encodeURIComponent(long)} end ${Buffer.from(long).toString('base64')}`;
    const redacted = redactor.redact(line);
    expect(redacted).not.toContain(long);
    expect(redacted).toBe(
      'start [REDACTED:app_secret] middle [REDACTED:app_secret] end [REDACTED:app_secret]',
    );
    lease.release();
    lease.release(); // idempotent: never drops an outer registration
    expect(redactor.redact(line)).toBe(line);
  });

  it('does not register a 3-char value, so unrelated log text is left intact', () => {
    const redactor = createRedactor();
    const short = 'abc';
    expect(short.length).toBeLessThan(MIN_REDACTABLE_SECRET_LENGTH);
    const lease = leaseSecrets(new Map([['s', appSecret(short)]]), redactor);
    const line = 'fetching abcdef from cabcab: abc ok';
    expect(redactor.redact(line)).toBe(line);
    lease.release();
  });

  it('keeps a registration held by an outer holder after the lease is released', () => {
    const redactor = createRedactor();
    const value = canary(32);
    redactor.register(value, 'app_secret');
    leaseSecrets(new Map([['a', appSecret(value)]]), redactor).release();
    expect(redactor.redact(value)).toBe('[REDACTED:app_secret]');
  });
});

describe('createSecret', () => {
  it('stores ciphertext and hint only and returns a value-free record', async () => {
    const raw = canary(32);
    const { handle, calls } = fakeHandle([storedRow({ raw })], 2);
    const record = await createSecret(
      handle,
      { owner: { scope: 'project', projectId: CHAIN.projectId }, name: 'api_token', value: appSecret(raw) },
      { current: CURRENT },
    );
    expect(calls.inserted?.keyVersion).toBe(2);
    expect(String(calls.inserted?.encryptedValue).startsWith('v2:')).toBe(true);
    expect(calls.inserted?.environmentId).toBeNull();
    expect(calls.inserted?.serviceId).toBeNull();
    expect(JSON.stringify(calls.inserted)).not.toContain(raw);
    expect(record).not.toHaveProperty('encryptedValue');
    expect(record).not.toHaveProperty('value');
    expect(JSON.stringify(record)).not.toContain(raw);
    expect(record.hint).toBe(raw.slice(-4));
  });

  it('uses key version 1 on an empty install', async () => {
    const { handle, calls } = fakeHandle([storedRow()], null);
    await createSecret(
      handle,
      {
        owner: { scope: 'service', projectId: CHAIN.projectId, serviceId: CHAIN.serviceId },
        name: 'db_password',
        value: appSecret(canary(20)),
      },
      { current: CURRENT },
    );
    expect(calls.inserted?.keyVersion).toBe(1);
    expect(calls.inserted?.serviceId).toBe(CHAIN.serviceId);
  });
});

describe('replaceSecret (H3)', () => {
  it('locks the row and bumps version in SQL, never as a computed number', async () => {
    const raw = canary(32);
    const { handle, calls } = fakeHandle([storedRow({ raw, version: 2 })]);
    const record = await replaceSecret(handle, '00000000-0000-7000-8000-000000000001', appSecret(raw), {
      current: CURRENT,
    });
    expect(calls.locked).toBe(true);
    expect(calls.updated?.version).toBeInstanceOf(SQL);
    expect(JSON.stringify(record)).not.toContain(raw);
    expect(record).not.toHaveProperty('encryptedValue');
  });

  it('refuses an unknown id with SECRET_NOT_FOUND', async () => {
    const { handle } = fakeHandle([]);
    await expect(
      replaceSecret(handle, '00000000-0000-7000-8000-000000000009', appSecret(canary(20)), { current: CURRENT }),
    ).rejects.toMatchObject({ code: 'SECRET_NOT_FOUND' });
  });
});

describe('decryptForDeploy', () => {
  it('returns SecretValue(app_secret) per id, registered until released', async () => {
    const raw = canary(40);
    const row = storedRow({ raw });
    const { handle } = fakeHandle([row]);
    const redactor = createRedactor();
    const lease = await decryptForDeploy(handle, { chain: CHAIN, secretIds: [row.id] }, { current: CURRENT }, redactor);
    const value = lease.values.get(row.id);
    expect(value?.kind).toBe('app_secret');
    expect(JSON.stringify([...lease.values.values()])).not.toContain(raw);
    expect(redactor.redact(`token=${raw}`)).toBe('token=[REDACTED:app_secret]');
    lease.release();
    expect(redactor.redact(`token=${raw}`)).toBe(`token=${raw}`);
  });

  it('refuses a foreign-project id even when the query returns it (defense in depth)', async () => {
    const row = storedRow({ projectId: FOREIGN_PROJECT });
    const { handle } = fakeHandle([row]);
    const redactor = createRedactor();
    await expect(
      decryptForDeploy(handle, { chain: CHAIN, secretIds: [row.id] }, { current: CURRENT }, redactor),
    ).rejects.toMatchObject({ code: 'SECRET_NOT_IN_SCOPE', secretId: row.id });
  });

  it('decrypts nothing and registers nothing when one id is out of scope', async () => {
    const inScope = storedRow({ id: '00000000-0000-7000-8000-000000000001', raw: canary(40) });
    const { handle } = fakeHandle([inScope]);
    const redactor = createRedactor();
    const register = redactor.register.bind(redactor);
    let registered = 0;
    redactor.register = (value, type) => {
      registered += 1;
      register(value, type);
    };
    await expect(
      decryptForDeploy(
        handle,
        { chain: CHAIN, secretIds: [inScope.id, '00000000-0000-7000-8000-000000000002'] },
        { current: CURRENT },
        redactor,
      ),
    ).rejects.toMatchObject({ code: 'SECRET_NOT_IN_SCOPE' });
    expect(registered).toBe(0);
  });

  it('returns an empty lease for no ids without querying', async () => {
    const lease = await decryptForDeploy(
      fakeHandle([]).handle,
      { chain: CHAIN, secretIds: [] },
      { current: CURRENT },
      createRedactor(),
    );
    expect(lease.values.size).toBe(0);
    lease.release();
  });

  it('surfaces a tampered row as SECRET_TAMPERED without the value', async () => {
    const row = storedRow({ encryptedValue: encryptSecret(canary(30), { key: OTHER, version: 1 }) });
    const { handle } = fakeHandle([row]);
    await expect(
      decryptForDeploy(handle, { chain: CHAIN, secretIds: [row.id] }, { current: CURRENT }, createRedactor()),
    ).rejects.toMatchObject({ code: 'SECRET_TAMPERED' });
  });
});


describe('multiline leases for line-oriented SSH', () => {
  it.each(['\n', '\r\n', '\r'])('registers long line components and encoded whole values for %j, with balanced release', (newline) => {
    const a = 'multiline-first-canary-23984';
    const b = 'multiline-final-canary-20374';
    const raw = `${a}${newline}${b}`;
    const redactor = createRedactor();
    redactor.register(a, 'app_secret');
    const lease = leaseSecrets(new Map([['one', appSecret(raw)], ['two', appSecret(raw)]]), redactor);
    for (const value of [a, b, raw, encodeURIComponent(raw), Buffer.from(raw).toString('base64')]) {
      expect(redactor.redact(value)).not.toContain(a);
      expect(redactor.redact(value)).not.toContain(b);
      expect(redactor.redact(value)).not.toBe(value);
    }
    lease.release(); lease.release();
    expect(redactor.redact(b)).toBe(b);
    expect(redactor.redact(a)).not.toBe(a);
    redactor.release(a);
    expect(redactor.redact(raw)).toBe(raw);
  });

  it('preserves the minimum length policy for multiline components', () => {
    const redactor = createRedactor();
    const lease = leaseSecrets(new Map([['one', appSecret('abc\nlong-enough-component')]]), redactor);
    expect(redactor.redact('abc')).toBe('abc');
    expect(redactor.redact('long-enough-component')).not.toBe('long-enough-component');
    lease.release();
    expect(redactor.redact('long-enough-component')).toBe('long-enough-component');
  });
});
