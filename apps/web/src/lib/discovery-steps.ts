// The six-step grouping DISC-02/D-06 narrates the eleven `DiscoveryCheckId`s through
// (05-UI-SPEC.md SS4.1). Mirrors `packages/ssh/src/run-discovery.ts`'s own
// `DISCOVERY_STEPS`/`DISCOVERY_SEQUENCE` idiom (05-PATTERNS.md): `CHECK_TO_STEP` is declared
// `as const satisfies Record<DiscoveryCheckId, DiscoveryStepName>` so a check id added to (or
// removed from) `@noodara/domain/discovery`'s `DISCOVERY_CHECK_IDS` without a matching update here
// is a compile error, never a silently unplaced check. `DISCOVERY_CHECK_IDS` itself is imported,
// never re-declared as a parallel local union (05-RESEARCH.md's "Don't Hand-Roll" table).
import { DISCOVERY_CHECK_IDS, type DiscoveryCheckId } from '@noodara/domain/discovery';

/** SS4.1's six named steps, in fixed display order. "SSH reachable" and "Authenticated" are
 *  resolved from the connection result, not from a `DiscoveryCheckId` -- no check ever maps to
 *  either (asserted by `discovery-steps.test.ts`, not just by this comment). */
export const DISCOVERY_STEP_NAMES = ['ssh_reachable', 'authenticated', 'os', 'resources', 'docker', 'access'] as const;

export type DiscoveryStepName = (typeof DISCOVERY_STEP_NAMES)[number];

// D-06's exact grouping: OS = hostname/os_release/arch; Resources = cpu/memory/disk/uptime;
// Docker = docker_version/docker_compose_version; Access = sudo/docker_group. Keys are quoted
// string literals (not bare identifiers) so each check id appears in this file exactly once, as
// a map key only -- never re-typed into a parallel union alongside it.
export const CHECK_TO_STEP = {
  'hostname': 'os',
  'os_release': 'os',
  'arch': 'os',
  'cpu': 'resources',
  'memory': 'resources',
  'disk': 'resources',
  'uptime': 'resources',
  'docker_version': 'docker',
  'docker_compose_version': 'docker',
  'sudo': 'access',
  'docker_group': 'access',
} as const satisfies Record<DiscoveryCheckId, DiscoveryStepName>;

/** SS4.1's exact human label for each step. */
export const STEP_LABELS = {
  ssh_reachable: 'SSH reachable',
  authenticated: 'Authenticated',
  os: 'OS',
  resources: 'Resources',
  docker: 'Docker',
  access: 'Access',
} as const satisfies Record<DiscoveryStepName, string>;

/** The four discovery-group steps, in the order they appear in `DISCOVERY_STEP_NAMES` -- the two
 *  connection-derived steps are never part of this list, since they carry no raw checks. */
export const DISCOVERY_GROUP_STEPS: readonly DiscoveryStepName[] = ['os', 'resources', 'docker', 'access'];

/** The two connection-derived steps, resolved from the connection result rather than from any
 *  `DiscoveryCheckId` -- exported so `discovery-progress.ts` never re-declares this pair. */
export const CONNECTION_STEP_NAMES: readonly DiscoveryStepName[] = ['ssh_reachable', 'authenticated'];

// Re-exported so callers building a per-step check list never re-import the tuple from
// `@noodara/domain/discovery` a second time just to iterate it in this module's own fixed order.
export { DISCOVERY_CHECK_IDS };
