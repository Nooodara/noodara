// 25-01 A2: reads the proxy side of a test server (as root) and the matching database rows, and
// asserts they agree (compareProxyState in remote-state.ts). The mapped QA-15 proxy scenarios call
// expectRemoteMatchesDatabase last; scenario-map.ts fails the map when one does not.
import { eq, inArray } from 'drizzle-orm';
import { expect } from 'vitest';
import { PROXY_CONTAINER_NAME, PROXY_LAYOUT, serviceIdFromProxyDynamicFileName } from '@noodara/domain';
import type { Database } from '../../../apps/control-plane/src/db/client.js';
import { domains, servers, services } from '../../../apps/control-plane/src/db/schema/index.js';
import type { StackExecResult } from '../helpers/deploy-engine.js';
import {
  compareProxyState,
  parseRouteHosts,
  type DatabaseDomain,
  type DatabaseProxyState,
  type RemoteProxyState,
  type RouteHost,
} from './remote-state.js';

/** Runs argv on the test server as root. */
export type RootExec = (argv: readonly string[]) => Promise<StackExecResult>;

const NETWORK_PREFIX = 'noodara-net-';

const lines = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

async function stdoutOf(exec: RootExec, argv: readonly string[]): Promise<string> {
  const result = await exec(argv);
  if (result.exitCode !== 0) throw new Error(`remote-state probe failed (${String(result.exitCode)}): ${argv.join(' ')}`);
  return result.stdout;
}

export async function readRemoteProxyState(exec: RootExec): Promise<RemoteProxyState> {
  const inspect = await exec(['docker', 'inspect', '--format', '{{.State.Running}}', PROXY_CONTAINER_NAME]);
  const proxy = inspect.exitCode !== 0 ? 'absent' : inspect.stdout.trim() === 'true' ? 'running' : 'stopped';

  const listing = await exec(['ls', '-A1', PROXY_LAYOUT.dynamicDir]);
  const dynamicEntries = listing.exitCode === 0 ? lines(listing.stdout) : [];
  const routes = new Map<string, readonly RouteHost[] | null>();
  for (const entry of dynamicEntries) {
    const id = serviceIdFromProxyDynamicFileName(entry);
    if (id === null) continue;
    routes.set(id, parseRouteHosts(await stdoutOf(exec, ['cat', `${PROXY_LAYOUT.dynamicDir}/${entry}`])));
  }

  const containers = lines(await stdoutOf(exec, ['docker', 'ps', '--all', '--format', '{{.Names}}']));
  const networkNames = lines(await stdoutOf(exec, ['docker', 'network', 'ls', '--filter', `name=${NETWORK_PREFIX}`, '--format', '{{.Name}}']));
  const networks = new Map<string, readonly string[]>();
  for (const name of networkNames.filter((candidate) => candidate.startsWith(NETWORK_PREFIX))) {
    const members = await stdoutOf(exec, ['docker', 'network', 'inspect', '--format', '{{range .Containers}}{{.Name}} {{end}}', name]);
    networks.set(name, members.split(' ').filter((member) => member !== '').map((member) => member.trim()));
  }
  return { proxy, dynamicEntries, routes, containers, networks };
}

export async function readDatabaseProxyState(db: Database, serverId: string): Promise<DatabaseProxyState> {
  const [server] = await db.select({ proxyStatus: servers.proxyStatus }).from(servers).where(eq(servers.id, serverId)).limit(1);
  if (server === undefined) throw new Error('remote-state probe: server row missing');
  const serviceRows = await db.select({ id: services.id }).from(services).where(eq(services.serverId, serverId));
  const ids = serviceRows.map((row) => row.id);
  const domainRows =
    ids.length === 0
      ? []
      : await db
          .select({ serviceId: domains.serviceId, hostname: domains.hostname, httpsRedirect: domains.httpsRedirect, applyStatus: domains.applyStatus })
          .from(domains)
          .where(inArray(domains.serviceId, ids));
  const byService = new Map<string, DatabaseDomain[]>(ids.map((id) => [id, []]));
  for (const row of domainRows) byService.get(row.serviceId)?.push(row);
  return { proxyStatus: server.proxyStatus, services: byService };
}

export interface RemoteMatchInput {
  readonly exec: RootExec;
  readonly db: Database;
  readonly serverId: string;
}

/** The server holds exactly what the database says: proxy, route files, networks, containers. */
export async function expectRemoteMatchesDatabase(input: RemoteMatchInput): Promise<void> {
  const [remote, database] = await Promise.all([readRemoteProxyState(input.exec), readDatabaseProxyState(input.db, input.serverId)]);
  expect(compareProxyState(remote, database)).toEqual([]);
}
