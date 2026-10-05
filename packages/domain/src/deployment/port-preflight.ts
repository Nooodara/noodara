// Published-port preflight (ROADMAP D10). Runs before `docker create` against the other services on
// the same server, the panel's own ports and the real `docker ps` snapshot; the first collision is
// `PORT_IN_USE` with its owner. Checked in that order so the reported owner is deterministic. The
// service's own container is skipped: a redeploy replaces it on the same port. Noodara publishes
// tcp only, so a udp binding on the same number is no collision.

import { assertDefined } from '../validators/network.js';
import type { ObservedContainer } from './docker-ps.js';

export interface PublishedHostPort {
  readonly hostPort: number;
  readonly protocol: string;
}

export interface PortPreflightInput {
  readonly serviceId: string;
  readonly publishedPort: number | null;
  readonly otherServices: readonly {
    readonly serviceId: string;
    readonly publishedPort: number | null;
  }[];
  readonly panelPorts: readonly { readonly port: number; readonly label: string }[];
  readonly containers: readonly ObservedContainer[];
}

export type PortOwner =
  | { readonly kind: 'panel'; readonly label: string }
  | { readonly kind: 'service'; readonly serviceId: string }
  | {
      readonly kind: 'container';
      readonly containerName: string;
      readonly serviceId: string | null;
    };

export type PortPreflightResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: 'PORT_IN_USE';
      readonly port: number;
      readonly owner: PortOwner;
    };

// `[host-ip:]host-port[-end]->container-port[-end]/proto`; `->` arrives already JSON-unescaped.
const BINDING = /:(\d+)(?:-(\d+))?->[\d-]+\/([a-z]+)$/;
const MAX_PORT = 65535;

/** Host-side bindings of a `docker ps` `Ports` string; exposed-only and malformed entries are skipped. */
export function parsePublishedHostPorts(ports: string): readonly PublishedHostPort[] {
  const result: PublishedHostPort[] = [];
  for (const entry of ports.split(',')) {
    const match = BINDING.exec(entry.trim());
    if (match === null) continue;
    const start = Number(assertDefined(match[1]));
    const end = match[2] === undefined ? start : Number(match[2]);
    const protocol = assertDefined(match[3]);
    if (end > MAX_PORT || end < start) continue;
    for (let port = start; port <= end; port += 1) {
      result.push({ hostPort: port, protocol });
    }
  }
  return result;
}

function inUse(port: number, owner: PortOwner): PortPreflightResult {
  return { ok: false, code: 'PORT_IN_USE', port, owner };
}

export function preflightPublishedPort(input: PortPreflightInput): PortPreflightResult {
  const { serviceId, publishedPort: port } = input;
  if (port === null) {
    return { ok: true };
  }

  const panel = input.panelPorts.find((p) => p.port === port);
  if (panel !== undefined) {
    return inUse(port, { kind: 'panel', label: panel.label });
  }

  const service = input.otherServices.find(
    (s) => s.serviceId !== serviceId && s.publishedPort === port,
  );
  if (service !== undefined) {
    return inUse(port, { kind: 'service', serviceId: service.serviceId });
  }

  const ownName = `noodara-${serviceId}`;
  const holder = input.containers.find(
    (c) =>
      c.name !== ownName &&
      c.labels['noodara.service_id'] !== serviceId &&
      parsePublishedHostPorts(c.ports).some((b) => b.hostPort === port && b.protocol === 'tcp'),
  );
  if (holder !== undefined) {
    return inUse(port, {
      kind: 'container',
      containerName: holder.name,
      serviceId: holder.labels['noodara.service_id'] ?? null,
    });
  }
  return { ok: true };
}
