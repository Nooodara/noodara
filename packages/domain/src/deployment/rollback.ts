// Rollback target selection: only a SUCCESS deployment with a parseable runtime config whose
// image is still retained. Returns a named reason instead of throwing.

import type { DeploymentStatus } from "./deployment-state.js";
import { parseRuntimeConfigSnapshot } from "./runtime-config.js";

export type RollbackRefusal =
  | "none"
  | "image_pruned"
  | "not_known_good"
  | "same_as_current"
  | "other_service";

export interface RollbackCandidate {
  readonly id: string;
  readonly serviceId: string;
  readonly status: DeploymentStatus;
  readonly createdAt: number;
  readonly imageRef: string | null;
  readonly runtimeConfig: unknown;
}

export interface RollbackContext {
  readonly serviceId: string;
  readonly currentDeploymentId: string;
  readonly deployments: readonly RollbackCandidate[];
}

export type RollbackSelection =
  | { readonly ok: true; readonly target: RollbackCandidate }
  | { readonly ok: false; readonly reason: RollbackRefusal };

const refuse = (reason: RollbackRefusal): RollbackSelection => ({ ok: false, reason });

/** known-good + retained -> true; known-good but pruned -> false; not known-good -> null. */
function retainedState(
  c: RollbackCandidate,
  retained: ReadonlySet<string>,
): boolean | null {
  if (c.status !== "SUCCESS") return null;
  const cfg = parseRuntimeConfigSnapshot(c.runtimeConfig);
  if (!cfg.ok) return null;
  return retained.has(cfg.value.imageRef);
}

export function selectRollbackTarget(
  context: RollbackContext,
  retainedImages: readonly string[],
  explicitTarget?: string,
): RollbackSelection {
  const retained = new Set(retainedImages);
  if (explicitTarget !== undefined) {
    if (explicitTarget === context.currentDeploymentId) return refuse("same_as_current");
    const found = context.deployments.find((d) => d.id === explicitTarget);
    if (found === undefined) return refuse("none");
    if (found.serviceId !== context.serviceId) return refuse("other_service");
    const state = retainedState(found, retained);
    if (state === null) return refuse("not_known_good");
    return state ? { ok: true, target: found } : refuse("image_pruned");
  }
  const candidates = context.deployments
    .filter((d) => d.serviceId === context.serviceId && d.id !== context.currentDeploymentId)
    .sort((a, b) => b.createdAt - a.createdAt);
  let pruned = false;
  for (const c of candidates) {
    const state = retainedState(c, retained);
    if (state === true) return { ok: true, target: c };
    if (state === false) pruned = true;
  }
  return refuse(pruned ? "image_pruned" : "none");
}
