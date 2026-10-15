// Image retention: keep the running image, in-flight images and N previous known-good ones.

import {
  NON_TERMINAL_DEPLOYMENT_STATUSES,
  type DeploymentStatus,
} from "./deployment-state.js";

export const DEFAULT_IMAGE_RETENTION = 3;
export const MIN_IMAGE_RETENTION = 1;
export const MAX_IMAGE_RETENTION = 10;

export interface RetentionDeployment {
  readonly id: string;
  readonly status: DeploymentStatus;
  readonly imageRef: string | null;
  readonly createdAt: number;
}

export interface ImageRetentionPlan {
  readonly keep: readonly string[];
  readonly delete: readonly string[];
}

function boundedN(n: number): number {
  if (!Number.isInteger(n)) return DEFAULT_IMAGE_RETENTION;
  return Math.min(MAX_IMAGE_RETENTION, Math.max(MIN_IMAGE_RETENTION, n));
}

export function imageRetention(
  history: readonly RetentionDeployment[],
  runningImageRef: string | null,
  n: number = DEFAULT_IMAGE_RETENTION,
): ImageRetentionPlan {
  const keep = new Set<string>();
  if (runningImageRef !== null) keep.add(runningImageRef);
  const withImage = history.filter(
    (d): d is RetentionDeployment & { imageRef: string } => d.imageRef !== null,
  );
  for (const d of withImage) {
    if ((NON_TERMINAL_DEPLOYMENT_STATUSES as readonly string[]).includes(d.status)) {
      keep.add(d.imageRef);
    }
  }
  const previous = new Set<string>();
  const newestFirst = withImage
    .filter((d) => d.status === "SUCCESS")
    .sort((a, b) => b.createdAt - a.createdAt);
  for (const d of newestFirst) {
    if (previous.size >= boundedN(n)) break;
    if (d.imageRef !== runningImageRef) previous.add(d.imageRef);
  }
  for (const ref of previous) keep.add(ref);
  const remove = [...new Set(withImage.map((d) => d.imageRef))].filter((r) => !keep.has(r));
  return { keep: [...keep], delete: remove };
}
