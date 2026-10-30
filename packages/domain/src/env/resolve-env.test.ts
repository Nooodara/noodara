import { describe, expect, it } from 'vitest';
import type { EnvValue } from './env-value.js';
import {
  ENV_SCOPES,
  type EnvDefinition,
  type EnvScope,
  resolveEnv,
  resolveSecretRefs,
} from './resolve-env.js';

const plain = (value: string): EnvValue => ({ kind: 'plain', value });
const ref = (name: string): EnvValue => ({ kind: 'secret_ref', name });
const def = (key: string, value: EnvValue): EnvDefinition => ({ key, value });

describe('ENV_SCOPES', () => {
  it('lists scopes from lowest to highest precedence', () => {
    expect(ENV_SCOPES).toEqual(['project', 'environment', 'service']);
  });
});

describe('resolveEnv (A2)', () => {
  // Every present/absent combination of one key across the three scopes.
  const combos = [0, 1, 2, 3, 4, 5, 6, 7].map((mask) => ({
    project: (mask & 1) !== 0,
    environment: (mask & 2) !== 0,
    service: (mask & 4) !== 0,
  }));

  it.each(combos)('project=$project environment=$environment service=$service', (combo) => {
    const p = combo.project ? [def('KEY', plain('p'))] : [];
    const e = combo.environment ? [def('KEY', plain('e'))] : [];
    const s = combo.service ? [def('KEY', plain('s'))] : [];
    const result = resolveEnv(p, e, s);

    const present: EnvScope[] = (['service', 'environment', 'project'] as const).filter(
      (scope) => combo[scope],
    );
    if (present.length === 0) {
      expect(result).toEqual([]);
      return;
    }
    const [winner, ...shadowed] = present as [EnvScope, ...EnvScope[]];
    const valueOf = (scope: EnvScope): EnvValue => plain(scope.charAt(0));
    expect(result).toEqual([
      {
        key: 'KEY',
        value: valueOf(winner),
        scope: winner,
        shadowed: shadowed.map((scope) => ({ scope, value: valueOf(scope) })),
      },
    ]);
  });

  it('a plain value shadows a reference and vice versa', () => {
    const result = resolveEnv(
      [def('A', ref('a_secret')), def('B', plain('project-b'))],
      [],
      [def('A', plain('service-a')), def('B', ref('b_secret'))],
    );
    expect(result).toEqual([
      {
        key: 'A',
        value: plain('service-a'),
        scope: 'service',
        shadowed: [{ scope: 'project', value: ref('a_secret') }],
      },
      {
        key: 'B',
        value: ref('b_secret'),
        scope: 'service',
        shadowed: [{ scope: 'project', value: plain('project-b') }],
      },
    ]);
  });

  it('sorts the output by key in code-unit order regardless of input order', () => {
    const result = resolveEnv(
      [def('Z', plain('1')), def('A_B', plain('2'))],
      [def('A', plain('3'))],
      [def('M', plain('4')), def('AB', plain('5'))],
    );
    expect(result.map((entry) => entry.key)).toEqual(['A', 'AB', 'A_B', 'M', 'Z']);
  });

  it('is deterministic: the same input gives equal output', () => {
    const p = [def('B', plain('1')), def('A', plain('2'))];
    const s = [def('A', ref('x'))];
    expect(resolveEnv(p, [], s)).toEqual(resolveEnv([...p].reverse(), [], s));
  });

  it('throws on a duplicate key inside one scope (programmer error)', () => {
    expect(() => resolveEnv([], [def('A', plain('1')), def('A', plain('2'))], [])).toThrow(
      /Duplicate env key A in environment scope/,
    );
  });
});

// Deterministic PRNG (mulberry32), same as hostname.test.ts: reproducible from the seed.
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 0x21_03;
const KEY_POOL = ['A', 'B', 'C', 'DB_URL', 'PORT', 'NODE_ENV', 'X1', '_Y', 'API_KEY', 'Z'];

function randomScope(next: () => number, tag: string): EnvDefinition[] {
  return KEY_POOL.filter(() => next() < 0.5).map((key) =>
    def(key, next() < 0.3 ? ref(`s_${tag}_${key.toLowerCase()}`) : plain(`${tag}:${key}`)),
  );
}

describe('resolveEnv property (H1)', () => {
  it('resolved keys are the union, each value is its highest-precedence definition, no repeats', () => {
    const next = mulberry32(SEED);
    for (let run = 0; run < 2000; run += 1) {
      const scopes = {
        project: randomScope(next, 'p'),
        environment: randomScope(next, 'e'),
        service: randomScope(next, 's'),
      };
      const result = resolveEnv(scopes.project, scopes.environment, scopes.service);
      const message = `seed ${SEED.toString()} run ${run.toString()}`;

      const union = new Set(ENV_SCOPES.flatMap((scope) => scopes[scope].map((d) => d.key)));
      const keys = result.map((entry) => entry.key);
      expect(new Set(keys).size, message).toBe(keys.length);
      expect([...keys].sort(), message).toEqual([...union].sort());
      expect(keys, message).toEqual([...keys].sort());

      for (const entry of result) {
        const highest = (['service', 'environment', 'project'] as const).find((scope) =>
          scopes[scope].some((d) => d.key === entry.key),
        );
        const expected = scopes[highest ?? 'project'].find((d) => d.key === entry.key);
        expect(entry.scope, message).toBe(highest);
        expect(entry.value, message).toEqual(expected?.value);
      }
    }
  });
});

describe('resolveSecretRefs (A3)', () => {
  it('passes plain values through and resolves references with service > environment > project', () => {
    const resolved = resolveEnv(
      [def('A', ref('shared')), def('P', plain('plain-p'))],
      [def('B', ref('env_only'))],
      [def('C', ref('proj_only'))],
    );
    const result = resolveSecretRefs(resolved, {
      project: [
        { name: 'shared', version: 1 },
        { name: 'proj_only', version: 4 },
        { name: 'env_only', version: 9 },
      ],
      environment: [
        { name: 'shared', version: 2 },
        { name: 'env_only', version: 5 },
      ],
      service: [{ name: 'shared', version: 3 }],
    });
    expect(result).toEqual({
      ok: true,
      value: [
        { key: 'A', secretRef: 'shared', secretVersion: 3, secretScope: 'service' },
        { key: 'B', secretRef: 'env_only', secretVersion: 5, secretScope: 'environment' },
        { key: 'C', secretRef: 'proj_only', secretVersion: 4, secretScope: 'project' },
        { key: 'P', value: 'plain-p' },
      ],
    });
  });

  it('treats absent scopes as empty', () => {
    const resolved = resolveEnv([], [], [def('A', ref('x'))]);
    expect(resolveSecretRefs(resolved, { environment: [{ name: 'x', version: 7 }] })).toEqual({
      ok: true,
      value: [{ key: 'A', secretRef: 'x', secretVersion: 7, secretScope: 'environment' }],
    });
  });

  it('returns SECRET_UNRESOLVED naming the first key and reference, and lists every miss', () => {
    const resolved = resolveEnv(
      [def('PLAIN', plain('visible?'))],
      [],
      [def('B', ref('missing_b')), def('A', ref('missing_a')), def('C', ref('ok'))],
    );
    const result = resolveSecretRefs(resolved, { service: [{ name: 'ok', version: 1 }] });
    expect(result).toEqual({
      ok: false,
      code: 'SECRET_UNRESOLVED',
      message: expect.stringContaining('A') as unknown,
      key: 'A',
      reference: 'missing_a',
      unresolved: [
        { key: 'A', reference: 'missing_a' },
        { key: 'B', reference: 'missing_b' },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('visible?');
  });

  it('resolves an empty env to an empty list', () => {
    expect(resolveSecretRefs([], {})).toEqual({ ok: true, value: [] });
  });
});
