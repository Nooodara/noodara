import { describe, expect, it } from 'vitest';
import { MAX_SECRET_VALUE_LENGTH } from '@noodara/domain/api-contract';
import type { Database } from '../db/client.js';
import {
  createSecretForOwner,
  removeSecret,
  replaceSecretValue,
  SecretServiceError,
  secretUsages,
  validateSecretValue,
  type ReferencingVariable,
  type SecretPlacement,
  type SecretServiceDeps,
  type ServicePlacement,
} from './secret-services.js';

const CANARY = 'canary-7c1e55aa-secret-value';
const PROJECT = '0190a000-0000-7000-8000-000000000001';
const SERVICE = '0190a000-0000-7000-8000-000000000002';
const SECRET = '0190a000-0000-7000-8000-000000000003';
const actor = { type: 'user', id: 'user-1' } as const;
const owner = { scope: 'service', projectId: PROJECT, serviceId: SERVICE } as const;

function deps(db: Database): SecretServiceDeps {
  return { db, now: () => new Date('2026-11-01T10:00:00Z'), masterKeys: { current: Buffer.alloc(32, 7) } };
}

/** A database whose every transaction fails the way Drizzle does: bound params in the message. */
function leakyDb(): Database {
  const fail = () => {
    const error = new Error(`Failed query: insert into "secrets" params: ${CANARY}`);
    Object.assign(error, { cause: Object.assign(new Error(`value ${CANARY} violates check`), { code: '23514' }) });
    return Promise.reject(error);
  };
  return { transaction: fail } as unknown as Database;
}

/** A database whose transactions fail with the secrets owner/name unique violation. */
function duplicateDb(): Database {
  const fail = () => {
    const error = new Error(`duplicate key ${CANARY}`);
    Object.assign(error, { cause: { code: '23505', constraint: 'secrets_owner_name_unique_idx' } });
    return Promise.reject(error);
  };
  return { transaction: fail } as unknown as Database;
}

function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => error,
  );
}

describe('validateSecretValue (23-03 A1, H1)', () => {
  it('accepts a single-line value up to the byte cap', () => {
    expect(validateSecretValue(CANARY)).toEqual({ ok: true, value: CANARY });
    expect(validateSecretValue('a'.repeat(MAX_SECRET_VALUE_LENGTH)).ok).toBe(true);
  });

  it.each<[string, unknown, string, string | undefined]>([
    ['an empty value', '', 'ENV_INPUT_INVALID', 'SECRET_VALUE_REQUIRED'],
    ['a non-string value', 42, 'ENV_INPUT_INVALID', 'SECRET_VALUE_INVALID'],
    ['an object value', { value: CANARY }, 'ENV_INPUT_INVALID', 'SECRET_VALUE_INVALID'],
    ['a value one byte over', 'a'.repeat(MAX_SECRET_VALUE_LENGTH + 1), 'ENV_INPUT_INVALID', 'SECRET_VALUE_TOO_LARGE'],
    ['multi-byte characters over the byte cap', 'é'.repeat(MAX_SECRET_VALUE_LENGTH / 2 + 1), 'ENV_INPUT_INVALID', 'SECRET_VALUE_TOO_LARGE'],
    ['a line feed', `${CANARY}\nx`, 'ENV_VALUE_MULTILINE', undefined],
    ['a carriage return', `${CANARY}\rx`, 'ENV_VALUE_MULTILINE', undefined],
    ['a NUL byte', `${CANARY}\u0000`, 'ENV_VALUE_MULTILINE', undefined],
    ['a lone surrogate', `${CANARY}\uD800`, 'ENV_INPUT_INVALID', 'SECRET_VALUE_INVALID_UTF8'],
  ])('rejects %s without quoting it', (_label, value, code, reason) => {
    const result = validateSecretValue(value);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(code);
    expect(result.reason).toBe(reason);
    expect(JSON.stringify(result)).not.toContain('canary');
  });
});

describe('secretUsages (23-03 A2)', () => {
  const ENV_A = 'env-a';
  const ENV_B = 'env-b';
  const projectServices: ServicePlacement[] = [
    { id: 'svc-a1', environmentId: ENV_A },
    { id: 'svc-a2', environmentId: ENV_A },
    { id: 'svc-b1', environmentId: ENV_B },
  ];
  const projectSecret: SecretPlacement = { id: 'sec-p', scope: 'project', environmentId: null, serviceId: null };
  const envASecret: SecretPlacement = { id: 'sec-ea', scope: 'environment', environmentId: ENV_A, serviceId: null };
  const svcSecret: SecretPlacement = { id: 'sec-s', scope: 'service', environmentId: null, serviceId: 'svc-a1' };
  const variable = (scope: ReferencingVariable['scope'], key: string, environmentId: string | null, serviceId: string | null) =>
    ({ scope, key, environmentId, serviceId }) satisfies ReferencingVariable;

  it('a project variable keeps a project secret in use', () => {
    expect(secretUsages('sec-p', [variable('project', 'DB', null, null)], [projectSecret], projectServices)).toEqual([
      { scope: 'project', key: 'DB' },
    ]);
  });

  it('a service variable shadowed by a service secret does not use the project secret', () => {
    const named = [projectSecret, svcSecret];
    expect(secretUsages('sec-p', [variable('service', 'DB', null, 'svc-a1')], named, projectServices)).toEqual([]);
    expect(secretUsages('sec-s', [variable('service', 'DB', null, 'svc-a1')], named, projectServices)).toEqual([
      { scope: 'service', key: 'DB' },
    ]);
  });

  it('a project variable uses the project secret wherever any service still resolves to it', () => {
    const named = [projectSecret, envASecret];
    // env A shadows it, env B still reads the project secret.
    expect(secretUsages('sec-p', [variable('project', 'DB', null, null)], named, projectServices)).toEqual([
      { scope: 'project', key: 'DB' },
    ]);
    expect(secretUsages('sec-ea', [variable('project', 'DB', null, null)], named, projectServices)).toEqual([
      { scope: 'project', key: 'DB' },
    ]);
  });

  it('an environment secret is not used by a variable of another environment', () => {
    const named = [projectSecret, envASecret];
    expect(secretUsages('sec-ea', [variable('environment', 'DB', ENV_B, null)], named, projectServices)).toEqual([]);
    expect(secretUsages('sec-ea', [variable('service', 'DB', null, 'svc-b1')], named, projectServices)).toEqual([]);
    expect(secretUsages('sec-ea', [variable('service', 'DB', null, 'svc-a2')], named, projectServices)).toEqual([
      { scope: 'service', key: 'DB' },
    ]);
  });

  it('an environment variable with no services still uses its own chain', () => {
    expect(secretUsages('sec-ea', [variable('environment', 'DB', ENV_A, null)], [envASecret], [])).toEqual([
      { scope: 'environment', key: 'DB' },
    ]);
  });

  it('deduplicates by scope and key and sorts project first, then by key', () => {
    const variables = [
      variable('service', 'B', null, 'svc-a2'),
      variable('environment', 'Z', ENV_A, null),
      variable('environment', 'Z', ENV_B, null),
      variable('project', 'Y', null, null),
      variable('service', 'A', null, 'svc-b1'),
    ];
    expect(secretUsages('sec-p', variables, [projectSecret], projectServices)).toEqual([
      { scope: 'project', key: 'Y' },
      { scope: 'environment', key: 'Z' },
      { scope: 'service', key: 'A' },
      { scope: 'service', key: 'B' },
    ]);
  });
});

describe('secret writes never echo a value (23-03 H1)', () => {
  it('rejects a bad name before touching the database', async () => {
    const result = await createSecretForOwner(deps({} as Database), {
      actor,
      owner,
      body: { name: 'Not A Name', value: CANARY },
    });
    expect(result).toMatchObject({ ok: false, code: 'ENV_INPUT_INVALID', reason: 'SECRET_NAME_INVALID' });
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  it.each([
    ['create', () => createSecretForOwner(deps(leakyDb()), { actor, owner, body: { name: 'api_key', value: CANARY } })],
    ['replace', () => replaceSecretValue(deps(leakyDb()), { actor, owner, secretId: SECRET, body: { value: CANARY } })],
    ['delete', () => removeSecret(deps(leakyDb()), { actor, owner, secretId: SECRET })],
  ])('%s turns a driver error into a value-free SecretServiceError', async (_label, run) => {
    const error = await caught(run());
    expect(error).toBeInstanceOf(SecretServiceError);
    expect((error as SecretServiceError).pgCode).toBe('23514');
    expect(JSON.stringify(error)).not.toContain(CANARY);
    expect(String(error)).not.toContain(CANARY);
    expect((error as Error).stack ?? '').not.toContain(CANARY);
    expect((error as { cause?: unknown }).cause).toBeUndefined();
  });

  it('maps the owner/name unique violation to SECRET_NAME_DUPLICATE', async () => {
    const result = await createSecretForOwner(deps(duplicateDb()), {
      actor,
      owner,
      body: { name: 'api_key', value: CANARY },
    });
    expect(result).toEqual({ ok: false, code: 'SECRET_NAME_DUPLICATE', message: 'A secret with this name already exists here.' });
  });
});
