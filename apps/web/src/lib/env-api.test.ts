import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createVariable,
  deleteVariable,
  getEffectiveEnv,
  listVariables,
  ownerPath,
  toEffectiveEnv,
  toVariableRow,
  updateVariable,
  type EnvOwner,
} from './env-api';

const P = '11111111-1111-4111-8111-111111111111';
const E = '33333333-3333-4333-8333-333333333333';
const S = '44444444-4444-4444-8444-444444444444';
const V = '77777777-7777-4777-8777-777777777777';

const PROJECT: EnvOwner = { scope: 'project', projectId: P };
const ENVIRONMENT: EnvOwner = { scope: 'environment', projectId: P, environmentId: E };
const SERVICE: EnvOwner = { scope: 'service', projectId: P, serviceId: S, environmentId: E };

const ROW = { id: V, scope: 'service', key: 'PORT', value: '3000', updatedAt: '2026-10-30T00:00:00.000Z', extra: 'drop' };

function mockFetch(body: unknown = {}, status = 200) {
  const fn = vi.fn(() =>
    Promise.resolve(
      status === 204
        ? new Response(null, { status })
        : new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
    ),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('env-api', () => {
  it('builds owner paths for the three scopes and rejects unsafe ids', () => {
    expect(ownerPath(PROJECT)).toBe(`/api/projects/${P}`);
    expect(ownerPath(ENVIRONMENT)).toBe(`/api/projects/${P}/environments/${E}`);
    expect(ownerPath(SERVICE)).toBe(`/api/projects/${P}/services/${S}`);
    expect(ownerPath({ scope: 'project', projectId: '../x' })).toBeNull();
    expect(ownerPath({ scope: 'environment', projectId: P, environmentId: 'a/b' })).toBeNull();
    expect(ownerPath({ scope: 'service', projectId: P, serviceId: 'a?b', environmentId: E })).toBeNull();
  });

  it('calls the variable routes with the right methods, paths and bodies', async () => {
    const fn = mockFetch(ROW);
    await createVariable(SERVICE, 'PORT', '3000');
    await updateVariable(ENVIRONMENT, V, '4000');
    const calls = fn.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url, init]) => `${init.method ?? '?'} ${url} ${typeof init.body === 'string' ? init.body : ''}`)).toEqual([
      `POST /api/projects/${P}/services/${S}/env {"key":"PORT","value":"3000"}`,
      `PATCH /api/projects/${P}/environments/${E}/env/${V} {"value":"4000"}`,
    ]);
    mockFetch(null, 204);
    expect(await deleteVariable(PROJECT, V)).toEqual({ ok: true, data: null });
  });

  it('never calls fetch for an unsafe id', async () => {
    const fn = mockFetch(ROW);
    expect((await updateVariable(PROJECT, '../v', 'x')).ok).toBe(false);
    expect((await deleteVariable(PROJECT, 'a b')).ok).toBe(false);
    expect((await getEffectiveEnv(P, '/x')).ok).toBe(false);
    expect((await listVariables({ scope: 'project', projectId: '%2e' })).ok).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it('lists variables field by field, dropping malformed rows and unknown fields', async () => {
    mockFetch({ items: [ROW, { id: 'x' }, 'junk'] });
    const result = await listVariables(SERVICE);
    expect(result).toEqual({
      ok: true,
      data: [{ id: V, scope: 'service', key: 'PORT', value: '3000', updatedAt: '2026-10-30T00:00:00.000Z' }],
    });
    mockFetch({ nope: true });
    expect((await listVariables(SERVICE)).ok).toBe(false);
  });

  it('keeps an unknown scope as a string', () => {
    expect(toVariableRow({ ...ROW, scope: 'galaxy' })?.scope).toBe('galaxy');
    expect(toVariableRow({ ...ROW, scope: 7 })?.scope).toBe('');
    expect(toVariableRow(null)).toBeNull();
  });

  it('reads the effective view with origins, shadowed definitions and differsFromRunning', async () => {
    const fn = mockFetch({
      items: [
        {
          key: 'DB',
          origin: 'service',
          value: { kind: 'secret_ref', name: 'db_password' },
          shadowed: [{ origin: 'project', value: { kind: 'plain', value: 'local' } }, { origin: 'x', value: { kind: 'bad' } }],
        },
        { key: 'BROKEN', origin: 'service', value: { kind: 'plain' } },
      ],
      differsFromRunning: true,
    });
    const result = await getEffectiveEnv(P, S);
    expect((fn.mock.calls as unknown as [string][])[0]?.[0]).toBe(`/api/projects/${P}/services/${S}/env/effective`);
    expect(result).toEqual({
      ok: true,
      data: {
        items: [
          {
            key: 'DB',
            origin: 'service',
            value: { kind: 'secret_ref', name: 'db_password' },
            shadowed: [{ origin: 'project', value: { kind: 'plain', value: 'local' } }],
          },
        ],
        differsFromRunning: true,
      },
    });
    expect(toEffectiveEnv({ items: [], differsFromRunning: 'yes' })).toEqual({ items: [], differsFromRunning: false });
    expect(toEffectiveEnv({})).toBeNull();
  });

  it('passes failures through with their code', async () => {
    mockFetch({ error: 'ENV_KEY_DUPLICATE', message: 'x' }, 409);
    const result = await createVariable(PROJECT, 'PORT', '1');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('ENV_KEY_DUPLICATE');
  });
});
