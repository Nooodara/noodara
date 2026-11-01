// 22-03 (ADR 0011): apply one service's domain routes on its server's proxy over an already
// connected SshDeploySession.
//   preflight  the proxy API answers (noodara-api router), else PROXY_UNAVAILABLE, nothing touched
//   network    the proxy joins noodara-net-<serviceId> (already joined or no network yet is fine:
//              the deploy connects it, 22-05)
//   write      render, write atomically (size + sha256 checked before the rename, `.prev` kept)
//   verify     every expected `@file` router reports `enabled` within verifyMs
//   rollback   on a failed verify `.prev` is restored and the result is PROXY_ROUTE_FAILED
// No domains left: the file is removed and the network disconnected.
// R1: web routers that redirect get a headers middleware first so the 302 carries
// `Cache-Control: no-store`; a removed redirect is never served from a client cache.
// Nothing here throws, logs or returns remote output: results carry closed codes only.
import {
  PROXY_API_ROUTER_NAME,
  proxyDynamicPathFor,
  proxyRouterNamesFor,
  renderDynamicConfig,
  type ProxyRouteDomain,
  type ProxyRouteService,
  type ResourceId,
} from '@noodara/domain';
import { secretValue } from '@noodara/domain/security';
import type { ValidationResult } from '@noodara/domain';
import {
  parseProxyRouterStatus,
  proxyFileDigest,
  proxyNetworkConnect,
  proxyNetworkDisconnect,
  proxyRemoveDynamic,
  proxyRestoreDynamic,
  proxyRouterStatus,
  proxyWriteDynamic,
  type RemoteCommand,
  type SshDeploySession,
} from '@noodara/ssh';

export interface DomainApplyLimits {
  /** Bound of one remote step. */
  readonly stepMs: number;
  /** How long Traefik may take to load the written file (its watch delay included). */
  readonly verifyMs: number;
  readonly verifyPollMs: number;
  readonly maxLineBytes: number;
}

export type DomainRenderer = (
  service: ProxyRouteService,
  domains: readonly ProxyRouteDomain[],
) => ValidationResult<string>;

export interface DomainApplyInput {
  readonly session: SshDeploySession;
  readonly service: { readonly id: ResourceId; readonly internalPort: number };
  readonly domains: readonly ProxyRouteDomain[];
  readonly limits: DomainApplyLimits;
  /** Test seam (A5: a forced invalid write); production renders with renderDynamicConfig. */
  readonly render?: DomainRenderer;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export type DomainApplyResult =
  | { readonly ok: true; readonly outcome: 'applied' | 'removed' }
  | {
      readonly ok: false;
      readonly code: 'PROXY_UNAVAILABLE' | 'PROXY_ROUTE_FAILED' | 'SERVER_UNREACHABLE';
      /** PROXY_ROUTE_FAILED only: `.prev` (or no file) is live again. */
      readonly restored: boolean;
    };

const OUTPUT_BYTES = 16_384;
const ALREADY_CONNECTED = /already exists|already attached|endpoint with name .* already/i;
const NO_NETWORK = /network .*not found|no such network/i;
const NOT_CONNECTED = /is not connected|not connected to (the )?network|no such network|network .*not found|no such container/i;

class Unreachable extends Error {
  constructor() {
    super('ssh session lost');
    this.name = 'Unreachable';
  }
}

interface Ran {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(
  session: SshDeploySession,
  command: RemoteCommand,
  limits: DomainApplyLimits,
  stdin?: string,
): Promise<Ran> {
  let result;
  try {
    result = await session.stream(command, {
      maxDurationMs: limits.stepMs,
      idleTimeoutMs: limits.stepMs,
      maxTotalBytes: OUTPUT_BYTES,
      maxLineBytes: limits.maxLineBytes,
      ...(stdin === undefined ? {} : { stdin: secretValue(stdin, 'app_secret') }),
      onChunk: () => {
        // Proxy output is classified from the tails, never logged.
      },
    });
  } catch {
    // A rejected stream is a lost connection (H3); the message can carry remote text, dropped.
    throw new Unreachable();
  }
  return {
    ok: result.outcome === 'completed' && result.exitCode === 0,
    stdout: result.stdoutTail,
    stderr: result.stderrTail,
  };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, sortKeys(record[key])]),
  );
}

/** R1: prepends a `Cache-Control: no-store` headers middleware to every redirecting router. */
export function withNoStoreRedirects(rendered: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rendered);
  } catch {
    return rendered;
  }
  if (typeof parsed !== 'object' || parsed === null) return rendered;
  const http = (parsed as { http?: unknown }).http;
  if (typeof http !== 'object' || http === null) return rendered;
  const record = http as { routers?: Record<string, { middlewares?: unknown }>; middlewares?: Record<string, unknown> };
  const routers = record.routers ?? {};
  for (const router of Object.values(routers)) {
    const list = router.middlewares;
    if (!Array.isArray(list)) continue;
    const redirect = list.find((name): name is string => typeof name === 'string' && name.endsWith('-redirect'));
    if (redirect === undefined) continue;
    const noStore = `${redirect.slice(0, -'-redirect'.length)}-nostore`;
    router.middlewares = [noStore, ...list.filter((name) => name !== noStore)];
    record.middlewares = {
      ...(record.middlewares ?? {}),
      [noStore]: { headers: { customResponseHeaders: { 'Cache-Control': 'no-store' } } },
    };
  }
  return JSON.stringify(sortKeys(parsed));
}

/** The production renderer: the domain package's file plus the R1 no-store middleware. */
export const renderServiceRoutes: DomainRenderer = (service, domains) => {
  const rendered = renderDynamicConfig(service, domains);
  return rendered.ok ? { ok: true, value: withNoStoreRedirects(rendered.value) } : rendered;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function proxyAnswers(session: SshDeploySession, limits: DomainApplyLimits): Promise<boolean> {
  const ran = await run(session, proxyRouterStatus(PROXY_API_ROUTER_NAME), limits);
  const status = parseProxyRouterStatus(ran.stdout);
  return status.kind === 'present' || status.kind === 'missing';
}

async function routersEnabled(input: DomainApplyInput, names: readonly string[]): Promise<boolean> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? defaultSleep;
  const deadline = now() + input.limits.verifyMs;
  const pending = new Set(names);
  for (;;) {
    for (const name of [...pending]) {
      const ran = await run(input.session, proxyRouterStatus(name), input.limits);
      const status = parseProxyRouterStatus(ran.stdout);
      if (status.kind === 'present' && status.status === 'enabled') pending.delete(name);
    }
    if (pending.size === 0) return true;
    if (now() >= deadline) return false;
    await sleep(input.limits.verifyPollMs);
  }
}

const UNAVAILABLE: DomainApplyResult = Object.freeze({ ok: false, code: 'PROXY_UNAVAILABLE', restored: false });
const UNREACHABLE: DomainApplyResult = Object.freeze({ ok: false, code: 'SERVER_UNREACHABLE', restored: false });

export async function applyServiceDomains(input: DomainApplyInput): Promise<DomainApplyResult> {
  const { session, service, limits } = input;
  const path = proxyDynamicPathFor(service.id);
  if (!path.ok) return { ok: false, code: 'PROXY_ROUTE_FAILED', restored: false };
  try {
    if (!(await proxyAnswers(session, limits))) return UNAVAILABLE;

    if (input.domains.length === 0) {
      const removed = await run(session, proxyRemoveDynamic(path.value), limits);
      if (!removed.ok || !removed.stdout.includes('NOODARA_PROXY_REMOVE ok')) {
        return { ok: false, code: 'PROXY_ROUTE_FAILED', restored: false };
      }
      const left = await run(session, proxyNetworkDisconnect(service.id), limits);
      if (!left.ok && !NOT_CONNECTED.test(left.stderr)) {
        return { ok: false, code: 'PROXY_ROUTE_FAILED', restored: false };
      }
      return { ok: true, outcome: 'removed' };
    }

    const rendered = (input.render ?? renderServiceRoutes)(service, input.domains);
    if (!rendered.ok) return { ok: false, code: 'PROXY_ROUTE_FAILED', restored: false };

    const joined = await run(session, proxyNetworkConnect(service.id), limits);
    if (!joined.ok && !ALREADY_CONNECTED.test(joined.stderr) && !NO_NETWORK.test(joined.stderr)) {
      return UNAVAILABLE;
    }

    const content = rendered.value;
    const written = await run(
      session,
      proxyWriteDynamic({ path: path.value, digest: proxyFileDigest(content) }),
      limits,
      content,
    );
    // The write renames only after the digest matched: a failed write left the live file as it was.
    if (!written.ok || !written.stdout.includes('NOODARA_PROXY_WRITE ok')) {
      return { ok: false, code: 'PROXY_ROUTE_FAILED', restored: false };
    }

    if (await routersEnabled(input, proxyRouterNamesFor(service.id, input.domains))) {
      return { ok: true, outcome: 'applied' };
    }
    const restore = await run(session, proxyRestoreDynamic(path.value), limits);
    return {
      ok: false,
      code: 'PROXY_ROUTE_FAILED',
      restored: restore.ok && restore.stdout.includes('NOODARA_PROXY_RESTORE'),
    };
  } catch (error) {
    if (error instanceof Unreachable) return UNREACHABLE;
    return { ok: false, code: 'PROXY_ROUTE_FAILED', restored: false };
  }
}

/** One apply at a time per service in this process: the last writer renders the latest rows. */
export function createServiceLock(): <T>(serviceId: string, task: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>();
  return async <T>(serviceId: string, task: () => Promise<T>): Promise<T> => {
    const previous = tails.get(serviceId) ?? Promise.resolve();
    const next = previous.then(task, task);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    tails.set(serviceId, settled);
    try {
      return await next;
    } finally {
      if (tails.get(serviceId) === settled) tails.delete(serviceId);
    }
  };
}
