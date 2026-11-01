// 25-01 A2: what the server holds for the proxy (noodara-traefik, dynamic/ files, noodara-net-*
// membership, service containers) compared with the database rows. Pure: remote-state-probe.ts
// reads both sides; the unit test in tests/unit/deploy-engine/scenario-map.test.ts drives this.
import {
  PROXY_CONTAINER_NAME,
  PROXY_DYNAMIC_DIR_ENTRY_SUFFIX,
  PROXY_ENTRYPOINT_WEB,
  serviceIdFromNetworkName,
  serviceIdFromProxyDynamicFileName,
} from '@noodara/domain';

export interface RouteHost {
  readonly hostname: string;
  readonly httpsRedirect: boolean;
}

export interface RemoteProxyState {
  readonly proxy: 'running' | 'stopped' | 'absent';
  /** Names in the dynamic/ directory (empty when it does not exist). */
  readonly dynamicEntries: readonly string[];
  /** Service id -> hosts of its `<id>.yml`; null when the file is not a rendered route file. */
  readonly routes: ReadonlyMap<string, readonly RouteHost[] | null>;
  readonly containers: readonly string[];
  /** `noodara-net-<id>` -> member container names. */
  readonly networks: ReadonlyMap<string, readonly string[]>;
}

export interface DatabaseDomain {
  readonly hostname: string;
  readonly httpsRedirect: boolean;
  readonly applyStatus: string;
}

export interface DatabaseProxyState {
  readonly proxyStatus: string;
  /** Every service row -> its domain rows. */
  readonly services: ReadonlyMap<string, readonly DatabaseDomain[]>;
}

const TEMP_PREFIX = '.noodara-';
const PREV_SUFFIX = '.prev';
const HOST_RULE = /^Host\(`([^`]+)`\)$/;
const SERVICE_CONTAINER = /^noodara-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-prev)?$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The web routers of a rendered dynamic file as hosts, sorted; null when it is not one. */
export function parseRouteHosts(content: string): RouteHost[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.http)) return null;
  const routers = parsed.http.routers ?? {};
  if (!isRecord(routers)) return null;
  const hosts: RouteHost[] = [];
  for (const router of Object.values(routers)) {
    if (!isRecord(router) || !Array.isArray(router.entryPoints) || !router.entryPoints.includes(PROXY_ENTRYPOINT_WEB)) continue;
    const hostname = typeof router.rule === 'string' ? HOST_RULE.exec(router.rule)?.[1] : undefined;
    if (hostname === undefined) return null;
    hosts.push({ hostname, httpsRedirect: Array.isArray(router.middlewares) && router.middlewares.length > 0 });
  }
  return hosts.sort((a, b) => (a.hostname < b.hostname ? -1 : a.hostname > b.hostname ? 1 : 0));
}

function routeFileServiceId(entry: string): string | null {
  const name = entry.endsWith(`${PROXY_DYNAMIC_DIR_ENTRY_SUFFIX}${PREV_SUFFIX}`) ? entry.slice(0, -PREV_SUFFIX.length) : entry;
  return serviceIdFromProxyDynamicFileName(name);
}

/** Every way the server disagrees with the database; empty when they match. */
export function compareProxyState(remote: RemoteProxyState, database: DatabaseProxyState): string[] {
  const problems: string[] = [];
  const domainsOf = (id: string): readonly DatabaseDomain[] => database.services.get(id) ?? [];
  const hasDomains = (id: string): boolean => domainsOf(id).length > 0;

  if (database.proxyStatus === 'RUNNING' && remote.proxy !== 'running') {
    problems.push(`proxy status RUNNING but ${PROXY_CONTAINER_NAME} is ${remote.proxy}`);
  }
  if (database.proxyStatus === 'NOT_INSTALLED' && remote.proxy !== 'absent') {
    problems.push(`proxy status NOT_INSTALLED but ${PROXY_CONTAINER_NAME} is ${remote.proxy}`);
  }

  for (const entry of remote.dynamicEntries) {
    if (entry.startsWith(TEMP_PREFIX)) {
      problems.push(`dynamic/${entry} is a leftover temp file`);
      continue;
    }
    const id = routeFileServiceId(entry);
    if (id !== null && !hasDomains(id)) problems.push(`dynamic/${entry} belongs to no service with domains`);
  }

  for (const [id, hosts] of remote.routes) {
    if (hosts === null) {
      problems.push(`service ${id}: the dynamic file is not a rendered route file`);
      continue;
    }
    const rows = domainsOf(id);
    for (const host of hosts) {
      const row = rows.find((candidate) => candidate.hostname === host.hostname);
      if (row === undefined) problems.push(`service ${id}: route for ${host.hostname} has no domain row`);
    }
  }

  for (const [id, rows] of database.services) {
    const hosts = remote.routes.get(id);
    for (const row of rows.filter((candidate) => candidate.applyStatus === 'APPLIED')) {
      const host = hosts?.find((candidate) => candidate.hostname === row.hostname);
      if (hosts === null) continue;
      if (host === undefined) {
        problems.push(`service ${id}: APPLIED domain ${row.hostname} has no route on the server`);
      } else if (host.httpsRedirect !== row.httpsRedirect) {
        problems.push(
          `service ${id}: ${row.hostname} httpsRedirect is ${String(host.httpsRedirect)} on the server, ${String(row.httpsRedirect)} in the database`,
        );
      }
    }
  }

  for (const name of remote.containers) {
    const id = SERVICE_CONTAINER.exec(name)?.[1];
    if (id !== undefined && !database.services.has(id)) problems.push(`container ${name} belongs to no service`);
  }

  for (const [network, members] of remote.networks) {
    const id = serviceIdFromNetworkName(network);
    if (id === null) continue;
    if (!database.services.has(id)) {
      problems.push(`network ${network} belongs to no service`);
      continue;
    }
    const attached = members.includes(PROXY_CONTAINER_NAME);
    const applied = domainsOf(id).some((row) => row.applyStatus === 'APPLIED');
    if (applied && remote.proxy === 'running' && !attached) {
      problems.push(`service ${id}: ${PROXY_CONTAINER_NAME} is not attached to ${network} although it has APPLIED domains`);
    }
    if (!hasDomains(id) && attached) problems.push(`service ${id}: ${PROXY_CONTAINER_NAME} is still attached to ${network} without domains`);
  }
  return problems;
}
