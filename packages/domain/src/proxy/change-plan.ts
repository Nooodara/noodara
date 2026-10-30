// What the proxy apply (22-01) must do to move a server from its current routing to the desired
// one: dynamic files to write or remove, service networks to connect or disconnect. Pure and
// convergent (H4): applying a plan and re-planning against the same target yields nothing.
// Execution order: connect, write, remove, disconnect (a route never points at an unreachable
// network, and a network is left only after its file is gone).

import {
  type NetworkName,
  type ProxyPath,
  type ResourceId,
  networkNameFor,
  proxyDynamicPathFor,
} from '../validators/docker-naming.js';
import { type ValidationResult, fail, ok } from '../validators/network.js';
import { type ProxyRouteDomain, type ProxyRouteService, renderDynamicConfig } from './dynamic-config.js';

/** Keyed by service id: rendered file content, and the services whose network the proxy joined. */
export interface ProxyState {
  readonly files: Readonly<Record<string, string>>;
  readonly networks: readonly string[];
}

export interface ProxyFileWrite {
  readonly serviceId: ResourceId;
  readonly path: ProxyPath;
  readonly content: string;
}

export interface ProxyFileRemoval {
  readonly serviceId: ResourceId;
  readonly path: ProxyPath;
}

export interface ProxyNetworkChange {
  readonly serviceId: ResourceId;
  readonly network: NetworkName;
}

export interface ProxyChangePlan {
  readonly connect: readonly ProxyNetworkChange[];
  readonly write: readonly ProxyFileWrite[];
  readonly remove: readonly ProxyFileRemoval[];
  readonly disconnect: readonly ProxyNetworkChange[];
}

export interface ProxyRoutedService {
  readonly service: ProxyRouteService;
  readonly domains: readonly ProxyRouteDomain[];
}

interface Located {
  readonly path: ProxyPath;
  readonly network: NetworkName;
}

function invalidServiceId<T>(): ValidationResult<T> {
  return fail('PROXY_PLAN_SERVICE_ID_INVALID', 'Proxy state keys must be lowercase service UUIDs');
}

/** Resolves every service id of a state to its file path and network, or fails on the first bad id. */
function locate(state: ProxyState, into: Map<string, Located>): boolean {
  for (const id of [...Object.keys(state.files), ...state.networks]) {
    if (into.has(id)) continue;
    const path = proxyDynamicPathFor(id);
    const network = networkNameFor(id);
    if (!path.ok || !network.ok) return false;
    into.set(id, { path: path.value, network: network.value });
  }
  return true;
}

function byKey([a]: readonly [string, Located], [b]: readonly [string, Located]): number {
  return a < b ? -1 : 1;
}

export function planProxyChange(
  current: ProxyState,
  desired: ProxyState,
): ValidationResult<ProxyChangePlan> {
  const ids = new Map<string, Located>();
  if (!locate(current, ids) || !locate(desired, ids)) return invalidServiceId();

  const currentNetworks = new Set(current.networks);
  const desiredNetworks = new Set(desired.networks);
  const connect: ProxyNetworkChange[] = [];
  const disconnect: ProxyNetworkChange[] = [];
  const write: ProxyFileWrite[] = [];
  const remove: ProxyFileRemoval[] = [];

  for (const [id, { path, network }] of [...ids.entries()].sort(byKey)) {
    const serviceId = id as ResourceId;
    if (desiredNetworks.has(id) && !currentNetworks.has(id)) connect.push({ serviceId, network });
    if (!desiredNetworks.has(id) && currentNetworks.has(id)) disconnect.push({ serviceId, network });
    // Keys are validated UUIDs, so no prototype key can be looked up here.
    const want = desired.files[id];
    const have = current.files[id];
    if (want !== undefined && want !== have) write.push({ serviceId, path, content: want });
    if (want === undefined && have !== undefined) remove.push({ serviceId, path });
  }

  return ok({ connect, write, remove, disconnect });
}

export function isProxyChangePlanEmpty(plan: ProxyChangePlan): boolean {
  return (
    plan.connect.length === 0 &&
    plan.write.length === 0 &&
    plan.remove.length === 0 &&
    plan.disconnect.length === 0
  );
}

/** The state after a plan ran to completion (used to prove convergence and by apply bookkeeping). */
export function applyProxyChange(current: ProxyState, plan: ProxyChangePlan): ProxyState {
  const files: Record<string, string> = { ...current.files };
  const networks = new Set(current.networks);
  for (const change of plan.connect) networks.add(change.serviceId);
  for (const change of plan.write) files[change.serviceId] = change.content;
  for (const change of plan.remove) Reflect.deleteProperty(files, change.serviceId);
  for (const change of plan.disconnect) networks.delete(change.serviceId);
  return { files, networks: [...networks].sort() };
}

/** Desired routing for a server: one file and one network per service that has domains. */
export function desiredProxyState(
  services: readonly ProxyRoutedService[],
): ValidationResult<ProxyState> {
  const files: Record<string, string> = {};
  const networks: string[] = [];
  const seen = new Set<string>();
  for (const { service, domains } of services) {
    if (seen.has(service.id)) {
      return fail('PROXY_PLAN_DUPLICATE_SERVICE', 'Each service may appear only once in the desired state');
    }
    seen.add(service.id);
    if (domains.length === 0) continue;
    const rendered = renderDynamicConfig(service, domains);
    if (!rendered.ok) return rendered;
    files[service.id] = rendered.value;
    networks.push(service.id);
  }
  return ok({ files, networks: networks.sort() });
}
