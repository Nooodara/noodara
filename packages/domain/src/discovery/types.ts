// Discovery result contracts (DISC-01, DISC-04, 02-CONTEXT.md D-11/D-12/D-13). Pure types and
// frozen literal tuples only — no functions, no I/O. `packages/ssh`'s `runDiscovery` (a later
// plan) produces a `DiscoverySnapshot`; this phase's only job here is declaring its shape so
// phase 3's persistence and phase 5's UI can both be written against a name that already exists.

import type { ServerErrorCode } from '../server/connection-result.js';

/** D-13: every discovery check reports one of these, never a thrown error. */
export const DISCOVERY_CHECK_STATUSES = ['pass', 'fail', 'skipped', 'not_applicable'] as const;

export type DiscoveryCheckStatus = (typeof DISCOVERY_CHECK_STATUSES)[number];

/**
 * One id per command template in `packages/ssh/src/commands` (SEC-04's allowlist) — the two
 * frozen tuples are asserted to be in exact one-to-one correspondence by
 * `packages/ssh/src/commands/allowlist.test.ts`. `'arch'` is included even though 02-CONTEXT.md's
 * Claude's-Discretion sketch of the allowlist omitted it: DISC-01 explicitly requires reporting
 * architecture, and a locked requirement outranks a discretionary sketch.
 */
export const DISCOVERY_CHECK_IDS = [
  'hostname',
  'os_release',
  'arch',
  'cpu',
  'memory',
  'disk',
  'uptime',
  'docker_version',
  'docker_compose_version',
  'sudo',
  'docker_group',
] as const;

export type DiscoveryCheckId = (typeof DISCOVERY_CHECK_IDS)[number];

/**
 * One reported outcome per discovery step (D-13). `detail` and `durationMs` feed phase 5's
 * step-by-step narrative (DISC-02) without any transform — the shape produced here is the shape
 * rendered there.
 */
export interface DiscoveryCheck {
  readonly id: DiscoveryCheckId;
  readonly status: DiscoveryCheckStatus;
  readonly detail: string;
  readonly durationMs: number;
}

/**
 * The denormalised facts collected in one discovery run, one field per `servers` table column
 * (`apps/control-plane/src/db/schema/servers.ts`) plus `dockerComposeVersion`. Every field is
 * nullable: a partial failure (D-11/D-12) still yields a `DiscoverySnapshot`, just with holes.
 */
export interface DiscoveryFacts {
  readonly hostname: string | null;
  readonly osDistribution: string | null;
  readonly osVersion: string | null;
  readonly arch: string | null;
  readonly cpuCores: number | null;
  readonly ramMb: number | null;
  readonly diskTotalMb: number | null;
  readonly diskUsedMb: number | null;
  readonly uptimeSeconds: number | null;
  readonly dockerInstalled: boolean | null;
  readonly dockerVersion: string | null;
  readonly dockerComposeVersion: string | null;
}

/**
 * The full result of one discovery run. `warnings` is how `UNSUPPORTED_OS` (D-11) and a missing
 * Docker (D-12) travel without demoting the connection out of `CONNECTED` — a non-empty
 * `warnings` array is not a failure, `checks` reports the granular pass/fail/skipped detail.
 */
export interface DiscoverySnapshot {
  readonly facts: DiscoveryFacts;
  readonly checks: readonly DiscoveryCheck[];
  readonly warnings: readonly ServerErrorCode[];
}

/** The two Ubuntu releases v0.1 supports (roadmap §6.2). Anything else is `UNSUPPORTED_OS`. */
export const SUPPORTED_UBUNTU_VERSIONS = ['22.04', '24.04'] as const;
