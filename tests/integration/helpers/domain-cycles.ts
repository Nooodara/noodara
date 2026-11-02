// 25-02: pure planner and checks behind the domain create/update/delete cycles stress suite
// (tests/integration/proxy/domain-cycles.test.ts). No I/O: the suite feeds them what it read from
// Postgres, the proxy's dynamic/ directory, the Traefik API and the process's handles.
import { parseRouteHosts } from '../proxy/remote-state.js';

export interface ModelDomain {
  readonly hostname: string;
  readonly httpsRedirect: boolean;
}

/** Service key -> its domains, as the database held them after the last cycle. */
export type DomainModel = ReadonlyMap<string, readonly ModelDomain[]>;

export type CycleOp =
  | { readonly kind: 'add'; readonly service: string; readonly hostname: string }
  | { readonly kind: 'redirect'; readonly service: string; readonly hostname: string; readonly httpsRedirect: boolean }
  | { readonly kind: 'delete'; readonly service: string; readonly hostname: string }
  /** The deploy's port re-apply (deploy-target `routes.reapply`) of a routed service. */
  | { readonly kind: 'reapply'; readonly service: string };

export type ConcurrentPair = 'post+delete' | 'patch+patch' | 'post+reapply';

export type CyclePlan =
  | { readonly mode: 'sequential'; readonly ops: readonly CycleOp[] }
  | { readonly mode: 'concurrent'; readonly pair: ConcurrentPair; readonly prepare: readonly CycleOp[]; readonly ops: readonly [CycleOp, CycleOp] }
  /** A create rendered by a forced-invalid applier; restored, then the failed row is deleted. */
  | { readonly mode: 'forced'; readonly prepare: readonly CycleOp[]; readonly service: string; readonly hostname: string };

export interface PlanOptions {
  readonly services: readonly string[];
  /** A fresh hostname for the n-th add of this cycle. */
  readonly hostFor: (cycle: number, n: number) => string;
  /** Domains kept per service at most (well under MAX_DOMAINS_PER_SERVICE). */
  readonly cap: number;
}

const PAIRS: readonly ConcurrentPair[] = ['post+delete', 'patch+patch', 'post+reapply'];
const SEQUENTIAL: readonly CycleOp['kind'][] = ['add', 'redirect', 'delete'];

export const isForcedCycle = (cycle: number): boolean => cycle % 10 === 0;
export const isConcurrentCycle = (cycle: number): boolean => cycle % 3 === 0 && !isForcedCycle(cycle);

/**
 * One cycle (1-based) over the current model. Every 10th cycle is a forced invalid write; every
 * 3rd other one fires two operations on the same service at once; the rest rotate add, redirect
 * toggle and delete across the services. A missing precondition is met with an add first.
 */
export function planCycle(cycle: number, model: DomainModel, options: PlanOptions): CyclePlan {
  const { services, cap } = options;
  if (services.length === 0) throw new Error('planCycle needs at least one service');
  let n = 0;
  const host = (): string => options.hostFor(cycle, n++);
  const domainsOf = (service: string): readonly ModelDomain[] => model.get(service) ?? [];
  // Shifted every third cycle so each service meets every kind of operation.
  const base = cycle + Math.floor(cycle / 3);
  const rotated = services.map((_, i) => services[(base + i) % services.length]).filter((s): s is string => s !== undefined);
  const first = (ok: (service: string) => boolean): string | undefined => rotated.find(ok);
  const service = rotated[0] ?? '';

  if (isForcedCycle(cycle)) {
    const routed = first((s) => domainsOf(s).length > 0);
    const target = routed ?? service;
    const prepare: CycleOp[] = routed === undefined ? [{ kind: 'add', service: target, hostname: host() }] : [];
    return { mode: 'forced', prepare, service: target, hostname: host() };
  }

  if (isConcurrentCycle(cycle)) {
    const pair = PAIRS[Math.floor(cycle / 3) % PAIRS.length] ?? 'post+delete';
    const room = (s: string) => domainsOf(s).length < cap;
    const target = first((s) => domainsOf(s).length > 0 && (pair === 'patch+patch' || room(s))) ?? first(room) ?? service;
    const prepare: CycleOp[] = [];
    let existing = domainsOf(target)[0];
    if (existing === undefined) {
      const hostname = host();
      prepare.push({ kind: 'add', service: target, hostname });
      existing = { hostname, httpsRedirect: false };
    }
    if (pair === 'post+delete') {
      return {
        mode: 'concurrent',
        pair,
        prepare,
        ops: [
          { kind: 'add', service: target, hostname: host() },
          { kind: 'delete', service: target, hostname: existing.hostname },
        ],
      };
    }
    if (pair === 'patch+patch') {
      // Opposite values on one row: the last writer wins, and the server must show that one.
      return {
        mode: 'concurrent',
        pair,
        prepare,
        ops: [
          { kind: 'redirect', service: target, hostname: existing.hostname, httpsRedirect: !existing.httpsRedirect },
          { kind: 'redirect', service: target, hostname: existing.hostname, httpsRedirect: existing.httpsRedirect },
        ],
      };
    }
    return { mode: 'concurrent', pair, prepare, ops: [{ kind: 'add', service: target, hostname: host() }, { kind: 'reapply', service: target }] };
  }

  const kind = SEQUENTIAL[Math.floor(cycle / services.length) % SEQUENTIAL.length] ?? 'add';
  const domains = domainsOf(service);
  const [oldest] = domains;
  if (kind === 'add' && domains.length >= cap && oldest !== undefined) {
    return { mode: 'sequential', ops: [{ kind: 'delete', service, hostname: oldest.hostname }] };
  }
  if (kind === 'add' || oldest === undefined) return { mode: 'sequential', ops: [{ kind: 'add', service, hostname: host() }] };
  if (kind === 'redirect') {
    const last = domains[domains.length - 1] ?? oldest;
    return { mode: 'sequential', ops: [{ kind: 'redirect', service, hostname: last.hostname, httpsRedirect: !last.httpsRedirect }] };
  }
  return { mode: 'sequential', ops: [{ kind: 'delete', service, hostname: oldest.hostname }] };
}

export interface DbDomain {
  readonly id: string;
  readonly serviceId: string;
  readonly hostname: string;
  readonly httpsRedirect: boolean;
  readonly applyStatus: string;
}

const TEMP_PREFIX = '.noodara-';
const ROUTE_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.yml(\.prev)?$/;

/** Service ids with at least one domain row, sorted. */
export function routedServiceIds(rows: readonly DbDomain[]): string[] {
  return [...new Set(rows.map((row) => row.serviceId))].sort();
}

/**
 * A1: dynamic/ holds the fixed entries plus exactly one `<id>.yml` per routed service; a `.prev`
 * (ADR 0011: the replaced file, kept for an idempotent restore, never loaded) only beside its own
 * live file; no temp file, no file of an unrouted service, nothing else.
 */
export function checkDynamicEntries(entries: readonly string[], routedIds: readonly string[], fixed: readonly string[]): string[] {
  const problems: string[] = [];
  const routed = new Set(routedIds);
  const present = new Set(entries);
  for (const entry of entries) {
    if (fixed.includes(entry)) continue;
    if (entry.startsWith(TEMP_PREFIX)) {
      problems.push(`dynamic/${entry}: leftover temp file`);
      continue;
    }
    const match = ROUTE_FILE.exec(entry);
    const id = match?.[1];
    if (id === undefined) {
      problems.push(`dynamic/${entry}: unexpected entry`);
    } else if (!routed.has(id)) {
      problems.push(`dynamic/${entry}: ${match?.[2] === undefined ? 'route file' : '.prev leftover'} of an unrouted service`);
    } else if (match?.[2] !== undefined && !present.has(`${id}.yml`)) {
      problems.push(`dynamic/${entry}: .prev without its live file`);
    }
  }
  for (const id of routedIds) if (!present.has(`${id}.yml`)) problems.push(`service ${id}: no dynamic file`);
  for (const name of fixed) if (!present.has(name)) problems.push(`dynamic/${name}: missing`);
  return problems;
}

/** A1: the live file of one routed service is a rendered route file with exactly its rows. */
export function checkRouteFile(serviceId: string, content: string, rows: readonly DbDomain[]): string[] {
  const hosts = parseRouteHosts(content);
  if (hosts === null) return [`service ${serviceId}: the dynamic file is not a valid route file`];
  const expected = rows
    .filter((row) => row.serviceId === serviceId)
    .map((row) => `${row.hostname} redirect=${String(row.httpsRedirect)}`)
    .sort();
  const actual = hosts.map((h) => `${h.hostname} redirect=${String(h.httpsRedirect)}`).sort();
  return JSON.stringify(actual) === JSON.stringify(expected)
    ? []
    : [`service ${serviceId}: file routes [${actual.join(', ')}], database [${expected.join(', ')}]`];
}

const DOMAIN_ROUTER = /^noodara-([0-9a-f-]{36})-([0-9a-f-]{36})-(web|websecure)@file$/;

/**
 * A1: every `@file` router Traefik serves is one of a domain row (both entry points enabled for
 * each row), or one of the fixed routers; nothing else.
 */
export function checkTraefikRouters(apiBody: string, rows: readonly DbDomain[], fixedRouters: readonly string[]): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(apiBody);
  } catch {
    return ['Traefik API: the router list is not JSON'];
  }
  if (!Array.isArray(parsed)) return ['Traefik API: the router list is not an array'];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of parsed as unknown[]) {
    const router = entry as { name?: unknown; status?: unknown };
    const name = typeof router.name === 'string' ? router.name : '';
    if (!name.endsWith('@file') || fixedRouters.includes(name)) continue;
    const match = DOMAIN_ROUTER.exec(name);
    const row = match === null ? undefined : rows.find((r) => r.serviceId === match[1] && r.id === match[2]);
    if (row === undefined) {
      problems.push(`Traefik router ${name} matches no domain row`);
      continue;
    }
    if (router.status !== 'enabled') problems.push(`Traefik router ${name} is ${String(router.status)}`);
    seen.add(name);
  }
  for (const row of rows) {
    for (const entryPoint of ['web', 'websecure']) {
      const name = `noodara-${row.serviceId}-${row.id}-${entryPoint}@file`;
      if (!seen.has(name)) problems.push(`domain ${row.hostname}: Traefik has no ${name}`);
    }
  }
  return problems;
}

/** A1: the proxy sits on exactly the `noodara-net-<id>` networks of the routed services. */
export function checkProxyNetworks(proxyNetworks: readonly string[], routedIds: readonly string[]): string[] {
  const actual = proxyNetworks.filter((name) => name.startsWith('noodara-net-')).sort();
  const expected = routedIds.map((id) => `noodara-net-${id}`).sort();
  return JSON.stringify(actual) === JSON.stringify(expected)
    ? []
    : [`proxy networks [${actual.join(', ')}], routed services [${expected.join(', ')}]`];
}

/** Every row the cycle left is APPLIED: nothing PENDING or FAILED behind the server. */
export function checkApplyStatuses(rows: readonly DbDomain[]): string[] {
  return rows.filter((row) => row.applyStatus !== 'APPLIED').map((row) => `domain ${row.hostname}: ${row.applyStatus}`);
}

export interface LatencySummary {
  readonly count: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
}

export function summarizeLatency(samples: readonly number[]): LatencySummary {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? 0;
  return { count: sorted.length, p50Ms: at(0.5), p95Ms: at(0.95), maxMs: sorted[sorted.length - 1] ?? 0 };
}

/** One of `process._getActiveHandles()`, reduced to what classifies it. */
export interface HandleInfo {
  readonly type: string;
  readonly remotePort?: number | undefined;
}

export interface HandleCounts {
  /** TCP sockets to the fixture's sshd: the control plane's open SSH connections. */
  readonly ssh: number;
  /** Pooled Postgres sockets: bounded by the pool, idle-closed, not a leak signal on their own. */
  readonly postgres: number;
  /** Every other handle (servers, timers, child processes, other sockets) by type. */
  readonly other: Readonly<Record<string, number>>;
}

export function countHandles(handles: readonly HandleInfo[], ports: { readonly ssh: number; readonly postgres: number }): HandleCounts {
  let ssh = 0;
  let postgres = 0;
  const other: Record<string, number> = {};
  for (const handle of handles) {
    if (handle.remotePort === ports.ssh) ssh += 1;
    else if (handle.remotePort === ports.postgres) postgres += 1;
    else other[handle.type] = (other[handle.type] ?? 0) + 1;
  }
  return { ssh, postgres, other };
}

/** H1: what grew since the baseline (empty: back at baseline). Postgres may not exceed its pool. */
export function handleGrowth(baseline: HandleCounts, now: HandleCounts, postgresPoolMax: number): string[] {
  const problems: string[] = [];
  if (now.ssh > baseline.ssh) problems.push(`${String(now.ssh - baseline.ssh)} SSH connections left open`);
  if (now.postgres > postgresPoolMax) problems.push(`${String(now.postgres)} Postgres sockets, pool max ${String(postgresPoolMax)}`);
  for (const [type, count] of Object.entries(now.other)) {
    const before = baseline.other[type] ?? 0;
    if (count > before) problems.push(`${String(count - before)} more ${type} handles than the baseline`);
  }
  return problems;
}
