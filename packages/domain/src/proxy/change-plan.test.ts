import { describe, expect, it } from 'vitest';
import type { Hostname } from '../domain/hostname.js';
import {
  type ProxyState,
  applyProxyChange,
  desiredProxyState,
  isProxyChangePlanEmpty,
  planProxyChange,
} from './change-plan.js';
import { renderDynamicConfig } from './dynamic-config.js';

const A = '3f2b8c1e-9a4d-4e7b-8c2f-1a2b3c4d5e6f';
const B = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const C = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const D = '11111111-2222-4333-8444-555555555555';
const EMPTY: ProxyState = { files: {}, networks: [] };

function plan(current: ProxyState, desired: ProxyState) {
  const result = planProxyChange(current, desired);
  if (!result.ok) throw new Error(`unexpected failure ${result.code}`);
  return result.value;
}

function codeOf(result: { ok: boolean; code?: string }): string | undefined {
  return result.ok ? undefined : result.code;
}

describe('planProxyChange (ADR 0011)', () => {
  it('writes new and changed files, removes stale ones, connects and disconnects networks', () => {
    const current: ProxyState = { files: { [A]: 'a1', [B]: 'b1' }, networks: [A, B] };
    const desired: ProxyState = { files: { [A]: 'a2', [C]: 'c1' }, networks: [C, A] };

    expect(plan(current, desired)).toEqual({
      connect: [{ serviceId: C, network: `noodara-net-${C}` }],
      write: [
        { serviceId: C, path: `/opt/noodara-proxy/dynamic/${C}.yml`, content: 'c1' },
        { serviceId: A, path: `/opt/noodara-proxy/dynamic/${A}.yml`, content: 'a2' },
      ],
      remove: [{ serviceId: B, path: `/opt/noodara-proxy/dynamic/${B}.yml` }],
      disconnect: [{ serviceId: B, network: `noodara-net-${B}` }],
    });
  });

  it('leaves unchanged files and networks alone', () => {
    const state: ProxyState = { files: { [A]: 'same' }, networks: [A] };
    const result = plan(state, { files: { [A]: 'same', [B]: 'new' }, networks: [A, B] });
    expect(result.write.map((w) => w.serviceId)).toEqual([B]);
    expect(result.connect.map((c) => c.serviceId)).toEqual([B]);
    expect(result.remove).toEqual([]);
    expect(result.disconnect).toEqual([]);
  });

  it('is sorted by service id regardless of input order, and treats duplicate networks as one', () => {
    const first = plan(EMPTY, { files: { [D]: 'd', [A]: 'a', [C]: 'c' }, networks: [D, A, C, A] });
    const second = plan(EMPTY, { files: { [C]: 'c', [A]: 'a', [D]: 'd' }, networks: [C, D, A] });
    expect(first).toEqual(second);
    expect(first.connect.map((c) => c.serviceId)).toEqual([C, D, A]);
  });

  it('rejects any key or network that is not a lowercase UUID', () => {
    for (const bad of ['', 'bridge', 'noodara-api', A.toUpperCase(), `${A}/..`, `${A}\n`]) {
      expect(codeOf(planProxyChange({ files: { [bad]: 'x' }, networks: [] }, EMPTY))).toBe(
        'PROXY_PLAN_SERVICE_ID_INVALID',
      );
      expect(codeOf(planProxyChange(EMPTY, { files: {}, networks: [bad] }))).toBe(
        'PROXY_PLAN_SERVICE_ID_INVALID',
      );
    }
  });

  it('H4: planProxyChange(x, x) is empty', () => {
    const states: ProxyState[] = [
      EMPTY,
      { files: { [A]: 'a' }, networks: [A] },
      { files: { [A]: 'a', [B]: 'b' }, networks: [B] },
      { files: {}, networks: [C, D] },
    ];
    for (const state of states) {
      const result = plan(state, state);
      expect(isProxyChangePlanEmpty(result)).toBe(true);
    }
    expect(isProxyChangePlanEmpty(plan(EMPTY, { files: {}, networks: [A] }))).toBe(false);
    expect(isProxyChangePlanEmpty(plan({ files: {}, networks: [A] }, EMPTY))).toBe(false);
    expect(isProxyChangePlanEmpty(plan(EMPTY, { files: { [A]: 'a' }, networks: [] }))).toBe(false);
    expect(isProxyChangePlanEmpty(plan({ files: { [A]: 'a' }, networks: [] }, EMPTY))).toBe(false);
  });
});

// Deterministic PRNG (mulberry32), as in resolve-env.test.ts: reproducible from the seed.
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

const POOL = Array.from(
  { length: 8 },
  (_, i) => `${i.toString(16).repeat(8)}-0000-4000-8000-${i.toString().padStart(12, '0')}`,
);
const CONTENTS = ['', 'x', 'y', '{"http":{}}\n'];
const SEED = 0x21_04;
const RUNS = 500;

function randomState(next: () => number): ProxyState {
  const files: Record<string, string> = {};
  const networks: string[] = [];
  for (const id of POOL) {
    if (next() < 0.5) files[id] = CONTENTS[Math.floor(next() * CONTENTS.length)] ?? '';
    if (next() < 0.5) networks.push(id);
    if (next() < 0.1) networks.push(id);
  }
  return { files, networks };
}

function normalised(state: ProxyState): { files: [string, string][]; networks: string[] } {
  return {
    files: Object.entries(state.files).sort(([a], [b]) => a.localeCompare(b)),
    networks: [...new Set(state.networks)].sort(),
  };
}

describe('H4: planProxyChange is convergent (property)', () => {
  it(`apply(current, plan(current, desired)) re-plans empty and equals desired (${RUNS.toString()} runs)`, () => {
    const next = mulberry32(SEED);
    for (let run = 0; run < RUNS; run += 1) {
      const current = randomState(next);
      const desired = randomState(next);
      const message = `seed ${SEED.toString()} run ${run.toString()}`;
      const applied = applyProxyChange(current, plan(current, desired));
      expect(isProxyChangePlanEmpty(plan(applied, desired)), message).toBe(true);
      expect(normalised(applied), message).toEqual(normalised(desired));
    }
  });
});

describe('desiredProxyState', () => {
  it('renders one file and one network per routed service and skips services without domains', () => {
    const domains = [{ id: B, hostname: 'app.acme.dev' as Hostname, httpsRedirect: true }];
    const result = desiredProxyState([
      { service: { id: A, internalPort: 3000 }, domains },
      { service: { id: C, internalPort: 8080 }, domains: [] },
    ]);
    const rendered = renderDynamicConfig({ id: A, internalPort: 3000 }, domains);
    expect(rendered.ok).toBe(true);
    expect(result).toEqual({
      ok: true,
      value: { files: { [A]: rendered.ok ? rendered.value : '' }, networks: [A] },
    });
  });

  it('propagates a render failure', () => {
    const result = desiredProxyState([
      { service: { id: 'bad', internalPort: 3000 }, domains: [{ id: B, hostname: 'a.acme.dev' as Hostname, httpsRedirect: true }] },
    ]);
    expect(codeOf(result)).toBe('PROXY_CONFIG_SERVICE_ID_INVALID');
  });

  it('rejects the same service twice', () => {
    const domains = [{ id: B, hostname: 'a.acme.dev' as Hostname, httpsRedirect: true }];
    const result = desiredProxyState([
      { service: { id: A, internalPort: 3000 }, domains },
      { service: { id: A, internalPort: 3000 }, domains },
    ]);
    expect(codeOf(result)).toBe('PROXY_PLAN_DUPLICATE_SERVICE');
  });
});
