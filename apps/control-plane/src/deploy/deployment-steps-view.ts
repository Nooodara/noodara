// 13-03 (A3): GET deployment views carry `steps[]`, derived by the domain's deriveDeploymentSteps
// from the view plus the row's step boundaries. A row without boundaries (pre-13-03, or a reader
// that found nothing) still gets a valid timeline from its status alone.
import { inArray } from 'drizzle-orm';
import {
  deriveDeploymentSteps,
  type DeploymentStepName,
  type DeploymentStepState,
} from '@noodara/domain/deployment';
import type { Database } from '../db/client.js';
import { deployments } from '../db/schema/deployments.js';
import type { DeploymentView } from '../services/deployment-services.js';

export interface DeploymentStepStamps {
  readonly buildingStartedAt: Date | null;
  readonly deployingStartedAt: Date | null;
  readonly verifyingStartedAt: Date | null;
}

export interface DeploymentStepView {
  readonly name: DeploymentStepName;
  readonly state: DeploymentStepState;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly durationMs: number | null;
}

export type DeploymentWithStepsView = DeploymentView & { readonly steps: DeploymentStepView[] };

/** Step boundaries by deployment id; ids with no row are absent from the map. */
export type DeploymentStepStampReader = (deploymentIds: readonly string[]) => Promise<ReadonlyMap<string, DeploymentStepStamps>>;

const NO_STAMPS: DeploymentStepStamps = { buildingStartedAt: null, deployingStartedAt: null, verifyingStartedAt: null };

export async function readDeploymentStepStamps(
  db: Database,
  deploymentIds: readonly string[],
): Promise<ReadonlyMap<string, DeploymentStepStamps>> {
  if (deploymentIds.length === 0) return new Map();
  const rows = await db
    .select({
      id: deployments.id,
      buildingStartedAt: deployments.buildingStartedAt,
      deployingStartedAt: deployments.deployingStartedAt,
      verifyingStartedAt: deployments.verifyingStartedAt,
    })
    .from(deployments)
    .where(inArray(deployments.id, [...deploymentIds]));
  return new Map(rows.map(({ id, ...stamps }) => [id, stamps]));
}

const toDate = (value: string | null): Date | null => (value === null ? null : new Date(value));
const toIso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

export function withDeploymentSteps(view: DeploymentView, stamps: DeploymentStepStamps | undefined): DeploymentWithStepsView {
  const boundaries = stamps ?? NO_STAMPS;
  const steps = deriveDeploymentSteps({
    status: view.status,
    sourceType: view.source.sourceType,
    errorCode: view.errorCode,
    startedAt: toDate(view.startedAt),
    buildingStartedAt: boundaries.buildingStartedAt,
    deployingStartedAt: boundaries.deployingStartedAt,
    verifyingStartedAt: boundaries.verifyingStartedAt,
    completedAt: toDate(view.completedAt),
  });
  return {
    ...view,
    steps: steps.map((step) => ({
      name: step.name,
      state: step.state,
      startedAt: toIso(step.startedAt),
      completedAt: toIso(step.completedAt),
      durationMs: step.durationMs,
    })),
  };
}

/** Attaches steps to each view with one boundary read. */
export async function attachDeploymentSteps(
  read: DeploymentStepStampReader,
  views: readonly DeploymentView[],
): Promise<DeploymentWithStepsView[]> {
  const stamps = await read(views.map((view) => view.id));
  return views.map((view) => withDeploymentSteps(view, stamps.get(view.id)));
}

export async function attachDeploymentStepsTo(read: DeploymentStepStampReader, view: DeploymentView): Promise<DeploymentWithStepsView> {
  const stamps = await read([view.id]);
  return withDeploymentSteps(view, stamps.get(view.id));
}
