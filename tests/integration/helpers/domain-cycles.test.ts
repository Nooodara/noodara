import { describe, expect, it } from 'vitest';
import {
  checkApplyStatuses,
  checkDynamicEntries,
  checkProxyNetworks,
  checkRouteFile,
  checkTraefikRouters,
  countHandles,
  handleGrowth,
  planCycle,
  routedServiceIds,
  summarizeLatency,
  type CycleOp,
  type DbDomain,
  type DomainModel,
  type ModelDomain,
} from './domain-cycles.js';

const SERVICES = ['a', 'b', 'c'];
const OPTIONS = { services: SERVICES, hostFor: (cycle: number, n: number) => `c${String(cycle)}n${String(n)}.cycles.test`, cap: 3 };

function applyOp(model: Map<string, ModelDomain[]>, op: CycleOp): void {
  const list = model.get(op.service) ?? [];
  if (op.kind === 'add') {
    expect(list.some((d) => d.hostname === op.hostname)).toBe(false);
    model.set(op.service, [...list, { hostname: op.hostname, httpsRedirect: false }]);
  } else if (op.kind === 'delete') {
    expect(list.some((d) => d.hostname === op.hostname), `delete ${op.hostname} not on ${op.service}`).toBe(true);
    model.set(op.service, list.filter((d) => d.hostname !== op.hostname));
  } else if (op.kind === 'redirect') {
    expect(list.some((d) => d.hostname === op.hostname), `redirect ${op.hostname} not on ${op.service}`).toBe(true);
    model.set(op.service, list.map((d) => (d.hostname === op.hostname ? { ...d, httpsRedirect: op.httpsRedirect } : d)));
  } else {
    expect(list.length, 'a deploy re-apply only runs for a routed service').toBeGreaterThan(0);
  }
}

describe('planCycle (25-02)', () => {
  it('50 cycles: every op is valid on the model, >= 10 concurrent pairs on one service, a forced write every 10th', () => {
    const model = new Map<string, ModelDomain[]>(SERVICES.map((s) => [s, []]));
    const kinds = new Map<string, Set<string>>(SERVICES.map((s) => [s, new Set<string>()]));
    const pairs = new Set<string>();
    let concurrent = 0;
    const forced: number[] = [];
    for (let cycle = 1; cycle <= 50; cycle += 1) {
      const plan = planCycle(cycle, model as DomainModel, OPTIONS);
      for (const op of plan.mode === 'sequential' ? [] : plan.prepare) applyOp(model, op);
      if (plan.mode === 'forced') {
        forced.push(cycle);
        expect(model.get(plan.service)?.length ?? 0).toBeGreaterThan(0);
        continue;
      }
      if (plan.mode === 'concurrent') {
        concurrent += 1;
        pairs.add(plan.pair);
        expect(plan.ops[0].service).toBe(plan.ops[1].service);
      }
      for (const op of plan.ops) {
        kinds.get(op.service)?.add(op.kind);
        applyOp(model, op);
      }
      for (const list of model.values()) expect(list.length).toBeLessThanOrEqual(OPTIONS.cap + 1);
    }
    expect(forced).toEqual([10, 20, 30, 40, 50]);
    expect(concurrent).toBeGreaterThanOrEqual(10);
    expect([...pairs].sort()).toEqual(['patch+patch', 'post+delete', 'post+reapply']);
    for (const service of SERVICES) expect([...(kinds.get(service) ?? [])].sort(), service).toEqual(expect.arrayContaining(['add', 'delete', 'redirect']));
  });

  it('meets a missing precondition with an add first', () => {
    const empty: DomainModel = new Map(SERVICES.map((s) => [s, []]));
    const forced = planCycle(10, empty, OPTIONS);
    expect(forced).toMatchObject({ mode: 'forced', prepare: [{ kind: 'add' }] });
    const pair = planCycle(6, empty, OPTIONS);
    expect(pair.mode).toBe('concurrent');
    if (pair.mode !== 'concurrent') throw new Error('unreachable');
    expect(pair.prepare).toHaveLength(1);
    expect(pair.prepare[0]?.kind).toBe('add');
    const seq = planCycle(4, empty, OPTIONS);
    expect(seq).toMatchObject({ mode: 'sequential', ops: [{ kind: 'add' }] });
  });

  it('PATCH+PATCH sets opposite values on the same row', () => {
    const model: DomainModel = new Map([['a', [{ hostname: 'x.test', httpsRedirect: false }]], ['b', []], ['c', []]]);
    const plan = planCycle(3, model, OPTIONS);
    expect(plan).toMatchObject({
      mode: 'concurrent',
      pair: 'patch+patch',
      ops: [
        { kind: 'redirect', hostname: 'x.test', httpsRedirect: true },
        { kind: 'redirect', hostname: 'x.test', httpsRedirect: false },
      ],
    });
  });
});

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const D1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const D2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const row = (serviceId: string, id: string, hostname: string, httpsRedirect = false, applyStatus = 'APPLIED'): DbDomain => ({
  id,
  serviceId,
  hostname,
  httpsRedirect,
  applyStatus,
});

function routeFile(hosts: { hostname: string; redirect: boolean }[]): string {
  const routers: Record<string, unknown> = {};
  hosts.forEach((h, i) => {
    routers[`r${String(i)}-web`] = { entryPoints: ['web'], rule: `Host(\`${h.hostname}\`)`, service: 's', middlewares: h.redirect ? ['m'] : [] };
    routers[`r${String(i)}-websecure`] = { entryPoints: ['websecure'], rule: `Host(\`${h.hostname}\`)`, service: 's' };
  });
  return JSON.stringify({ http: { routers } });
}

describe('per-cycle invariants (25-02 A1)', () => {
  const FIXED = ['noodara-api.yml'];

  it('dynamic/: one file per routed service, .prev only beside its live file, no temp or orphan', () => {
    expect(checkDynamicEntries(['noodara-api.yml', `${S1}.yml`, `${S1}.yml.prev`], [S1], FIXED)).toEqual([]);
    expect(checkDynamicEntries(['noodara-api.yml', `${S1}.yml`, `${S2}.yml.prev`, '.noodara-AbC123', 'x.yml'], [S1], FIXED)).toEqual([
      `dynamic/${S2}.yml.prev: .prev leftover of an unrouted service`,
      'dynamic/.noodara-AbC123: leftover temp file',
      'dynamic/x.yml: unexpected entry',
    ]);
    expect(checkDynamicEntries([`${S2}.yml`], [S1], FIXED)).toEqual([
      `dynamic/${S2}.yml: route file of an unrouted service`,
      `service ${S1}: no dynamic file`,
      'dynamic/noodara-api.yml: missing',
    ]);
  });

  it('a route file carries exactly its rows and redirect flags', () => {
    const rows = [row(S1, D1, 'a.test'), row(S1, D2, 'b.test', true), row(S2, D1, 'c.test')];
    expect(checkRouteFile(S1, routeFile([{ hostname: 'b.test', redirect: true }, { hostname: 'a.test', redirect: false }]), rows)).toEqual([]);
    expect(checkRouteFile(S1, routeFile([{ hostname: 'a.test', redirect: true }]), rows)).toHaveLength(1);
    expect(checkRouteFile(S1, '{not json', rows)).toEqual([`service ${S1}: the dynamic file is not a valid route file`]);
  });

  it('Traefik @file routers equal the domain rows, both entry points enabled', () => {
    const rows = [row(S1, D1, 'a.test')];
    const api = (extra: object[] = []) =>
      JSON.stringify([
        { name: 'api@internal', status: 'enabled' },
        { name: 'noodara-api@file', status: 'enabled' },
        { name: `noodara-${S1}-${D1}-web@file`, status: 'enabled' },
        { name: `noodara-${S1}-${D1}-websecure@file`, status: 'enabled' },
        ...extra,
      ]);
    expect(checkTraefikRouters(api(), rows, ['noodara-api@file'])).toEqual([]);
    expect(checkTraefikRouters(api([{ name: `noodara-${S2}-${D2}-web@file`, status: 'enabled' }]), rows, ['noodara-api@file'])).toEqual([
      `Traefik router noodara-${S2}-${D2}-web@file matches no domain row`,
    ]);
    expect(checkTraefikRouters(api(), [...rows, row(S2, D2, 'b.test')], ['noodara-api@file'])).toEqual([
      `domain b.test: Traefik has no noodara-${S2}-${D2}-web@file`,
      `domain b.test: Traefik has no noodara-${S2}-${D2}-websecure@file`,
    ]);
    const disabled = JSON.stringify([
      { name: `noodara-${S1}-${D1}-web@file`, status: 'disabled' },
      { name: `noodara-${S1}-${D1}-websecure@file`, status: 'enabled' },
    ]);
    expect(checkTraefikRouters(disabled, rows, [])).toEqual([`Traefik router noodara-${S1}-${D1}-web@file is disabled`]);
    expect(checkTraefikRouters('<html>', rows, [])).toEqual(['Traefik API: the router list is not JSON']);
    expect(checkTraefikRouters('{}', rows, [])).toEqual(['Traefik API: the router list is not an array']);
  });

  it('proxy networks equal the routed services; rows all APPLIED', () => {
    expect(checkProxyNetworks(['noodara-proxy', `noodara-net-${S1}`], [S1])).toEqual([]);
    expect(checkProxyNetworks([`noodara-net-${S2}`], [S1])).toHaveLength(1);
    expect(checkProxyNetworks([], [])).toEqual([]);
    expect(routedServiceIds([row(S2, D1, 'a'), row(S1, D2, 'b'), row(S2, D2, 'c')])).toEqual([S1, S2]);
    expect(checkApplyStatuses([row(S1, D1, 'a.test'), row(S1, D2, 'b.test', false, 'FAILED')])).toEqual(['domain b.test: FAILED']);
  });
});

describe('latency and handles (25-02 A2, H1)', () => {
  it('summarizes latency samples', () => {
    expect(summarizeLatency([])).toEqual({ count: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 });
    const samples = Array.from({ length: 20 }, (_, i) => (i + 1) * 100);
    expect(summarizeLatency(samples)).toEqual({ count: 20, p50Ms: 1000, p95Ms: 1900, maxMs: 2000 });
  });

  it('counts SSH and Postgres sockets apart and reports growth over the baseline', () => {
    const ports = { ssh: 32_022, postgres: 32_543 };
    const baseline = countHandles([{ type: 'Socket' }, { type: 'Socket', remotePort: 32_543 }, { type: 'Server' }], ports);
    expect(baseline).toEqual({ ssh: 0, postgres: 1, other: { Socket: 1, Server: 1 } });
    const same = countHandles(
      [{ type: 'Socket' }, { type: 'Socket', remotePort: 32_543 }, { type: 'Socket', remotePort: 32_543 }, { type: 'Server' }],
      ports,
    );
    expect(handleGrowth(baseline, same, 10)).toEqual([]);
    const leaked = countHandles(
      [{ type: 'Socket' }, { type: 'Socket', remotePort: 32_022 }, { type: 'Server' }, { type: 'ChildProcess' }],
      ports,
    );
    expect(handleGrowth(baseline, leaked, 10)).toEqual(['1 SSH connections left open', '1 more ChildProcess handles than the baseline']);
    expect(handleGrowth(baseline, { ssh: 0, postgres: 11, other: {} }, 10)).toEqual(['11 Postgres sockets, pool max 10']);
  });
});
