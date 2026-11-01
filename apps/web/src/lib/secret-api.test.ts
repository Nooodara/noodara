import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EnvOwner } from './env-api';
import {
  createSecret,
  deleteSecret,
  listSecrets,
  listVisibleSecrets,
  replaceSecret,
  toSecretRow,
  toUsages,
  visibleOwners,
} from './secret-api';

const P = '11111111-1111-4111-8111-111111111111';
const E = '33333333-3333-4333-8333-333333333333';
const S = '44444444-4444-4444-8444-444444444444';
const X = '88888888-8888-4888-8888-888888888888';

const PROJECT: EnvOwner = { scope: 'project', projectId: P };
const ENVIRONMENT: EnvOwner = { scope: 'environment', projectId: P, environmentId: E };
const SERVICE: EnvOwner = { scope: 'service', projectId: P, serviceId: S, environmentId: E };

const secret = (id: string, name: string, scope: string) => ({
  id,
  scope,
  name,
  hint: '••••abcd',
  version: 2,
  updatedAt: '2026-10-30T00:00:00.000Z',
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function mockFetch(body: unknown = {}, status = 200) {
  const fn = vi.fn(() => Promise.resolve(status === 204 ? new Response(null, { status }) : json(body, status)));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('secret-api', () => {
  it('reads rows value-free, dropping any value field', () => {
    expect(toSecretRow({ ...secret(X, 'db', 'project'), value: 'CANARY' })).toEqual(secret(X, 'db', 'project'));
    expect(toSecretRow({ id: X, name: 'db', version: 1.5 })).toEqual({ id: X, scope: '', name: 'db', hint: '', version: 1, updatedAt: null });
    expect(toSecretRow({ id: X })).toBeNull();
  });

  it('calls create and replace as sensitive writes on the right paths', async () => {
    const fn = mockFetch(secret(X, 'db', 'service'));
    await createSecret(SERVICE, 'db', 'v1');
    await replaceSecret(PROJECT, X, 'v2');
    const calls = fn.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url, init]) => `${init.method ?? '?'} ${url} ${typeof init.body === 'string' ? init.body : ''}`)).toEqual([
      `POST /api/projects/${P}/services/${S}/secrets {"name":"db","value":"v1"}`,
      `PUT /api/projects/${P}/secrets/${X} {"value":"v2"}`,
    ]);
  });

  it('lists the visible owners nearest first', () => {
    expect(visibleOwners(PROJECT)).toEqual([PROJECT]);
    expect(visibleOwners(ENVIRONMENT)).toEqual([ENVIRONMENT, PROJECT]);
    expect(visibleOwners(SERVICE)).toEqual([SERVICE, ENVIRONMENT, PROJECT]);
  });

  it('merges visible secrets, the nearest definition of a name wins', async () => {
    const fn = vi.fn((url: string) => {
      if (url.includes('/services/')) return Promise.resolve(json({ items: [secret('a', 'db', 'service')] }));
      if (url.includes('/environments/')) return Promise.resolve(json({ items: [secret('b', 'db', 'environment'), secret('c', 'api', 'environment')] }));
      return Promise.resolve(json({ items: [secret('d', 'token', 'project'), secret('e', 'api', 'project')] }));
    });
    vi.stubGlobal('fetch', fn);
    const result = await listVisibleSecrets(SERVICE);
    expect(result.ok && result.data.map((row) => `${row.name}:${row.scope}`)).toEqual(['db:service', 'api:environment', 'token:project']);
  });

  it('fails the visible list when one scope fails', async () => {
    mockFetch({ error: 'INTERNAL_ERROR', message: 'x' }, 500);
    expect((await listVisibleSecrets(ENVIRONMENT)).ok).toBe(false);
    mockFetch({ items: 'nope' });
    expect((await listSecrets(PROJECT)).ok).toBe(false);
  });

  it('deletes a secret and reads the SECRET_IN_USE usedBy list', async () => {
    const ok = mockFetch(null, 204);
    expect(await deleteSecret(SERVICE, X)).toEqual({ ok: true, data: null });
    const [url, init] = (ok.mock.calls as unknown as [string, RequestInit][])[0] ?? ['', {}];
    expect(url).toBe(`/api/projects/${P}/services/${S}/secrets/${X}`);
    expect(init.method).toBe('DELETE');
    expect(init.credentials).toBe('same-origin');

    mockFetch(
      {
        error: 'SECRET_IN_USE',
        message: 'in use',
        usedBy: [{ scope: 'service', key: 'DATABASE_PASSWORD' }, { scope: 'project', key: '<img src=x>' }, 'junk'],
      },
      409,
    );
    const result = await deleteSecret(SERVICE, X);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('SECRET_IN_USE');
    expect(!result.ok && result.usedBy).toEqual([{ scope: 'service', key: 'DATABASE_PASSWORD' }]);
  });

  it('maps other delete failures and network errors', async () => {
    mockFetch({ error: 'NOT_FOUND', message: 'x' }, 404);
    const missing = await deleteSecret(PROJECT, X);
    expect(!missing.ok && missing.code).toBe('NOT_FOUND');
    expect(!missing.ok && 'usedBy' in missing).toBe(false);
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
    const offline = await deleteSecret(PROJECT, X);
    expect(!offline.ok && offline.code).toBe('NETWORK_ERROR');
  });

  it('never calls fetch for an unsafe id', async () => {
    const fn = mockFetch({});
    expect((await deleteSecret(PROJECT, '../x')).ok).toBe(false);
    expect((await replaceSecret(PROJECT, 'a/b', 'v')).ok).toBe(false);
    expect(fn).not.toHaveBeenCalled();
    expect(toUsages('nope')).toEqual([]);
  });
});
