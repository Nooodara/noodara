import { describe, expect, it } from 'vitest';
import type { DeploymentView } from '../services/deployment-services.js';
import {
  attachDeploymentSteps,
  attachDeploymentStepsTo,
  withDeploymentSteps,
  type DeploymentStepStampReader,
  type DeploymentStepStamps,
} from './deployment-steps-view.js';

const ID_A = '0192f1a4-7b3c-7d2e-8f00-00000000ccc1';
const ID_B = '0192f1a4-7b3c-7d2e-8f00-00000000ccc2';
const at = (seconds: number): Date => new Date(Date.UTC(2026, 9, 6, 10, 0, seconds));

function view(overrides: Partial<DeploymentView> = {}): DeploymentView {
  return {
    id: ID_A,
    serviceId: '0192f1a4-7b3c-7d2e-8f00-00000000bbbb',
    status: 'SUCCESS',
    trigger: 'manual',
    triggeredBy: null,
    source: {
      sourceType: 'git',
      repositoryUrl: 'https://github.com/acme/api.git',
      branch: 'main',
      buildContext: '.',
      dockerfilePath: 'Dockerfile',
      buildTarget: null,
      imageRef: null,
      internalPort: 3000,
      publishedPort: 8080,
    },
    commitSha: null,
    previousDeploymentId: null,
    startedAt: at(0).toISOString(),
    completedAt: at(30).toISOString(),
    durationMs: 30000,
    errorCode: null,
    errorMessage: null,
    createdAt: at(0).toISOString(),
    updatedAt: at(30).toISOString(),
    ...overrides,
  };
}

const STAMPS: DeploymentStepStamps = { buildingStartedAt: at(5), deployingStartedAt: at(20), verifyingStartedAt: at(22) };

describe('withDeploymentSteps (13-03 A3)', () => {
  it('serializes the four derived steps with ISO times', () => {
    expect(withDeploymentSteps(view(), STAMPS).steps).toEqual([
      { name: 'clone', state: 'success', startedAt: at(0).toISOString(), completedAt: at(5).toISOString(), durationMs: 5000 },
      { name: 'build', state: 'success', startedAt: at(5).toISOString(), completedAt: at(20).toISOString(), durationMs: 15000 },
      { name: 'start', state: 'success', startedAt: at(20).toISOString(), completedAt: at(22).toISOString(), durationMs: 2000 },
      { name: 'verify', state: 'success', startedAt: at(22).toISOString(), completedAt: at(30).toISOString(), durationMs: 8000 },
    ]);
  });

  it('a failed deploy marks the failing step failed and later steps pending', () => {
    const failed = view({ status: 'FAILED', errorCode: 'BUILD_FAILED', completedAt: at(9).toISOString() });
    const steps = withDeploymentSteps(failed, { ...STAMPS, deployingStartedAt: null, verifyingStartedAt: null }).steps;
    expect(steps.map((step) => step.state)).toEqual(['success', 'failed', 'pending', 'pending']);
  });

  it('a cancel marks the running step cancelled', () => {
    const cancelled = view({ status: 'CANCELLED', completedAt: at(21).toISOString() });
    const steps = withDeploymentSteps(cancelled, { ...STAMPS, verifyingStartedAt: null }).steps;
    expect(steps.map((step) => step.state)).toEqual(['success', 'success', 'cancelled', 'pending']);
  });

  it('a row without boundaries derives its steps from the status alone', () => {
    const steps = withDeploymentSteps(view({ status: 'BUILDING', completedAt: null }), undefined).steps;
    expect(steps.map((step) => step.state)).toEqual(['success', 'running', 'pending', 'pending']);
  });
});

describe('attachDeploymentSteps', () => {
  it('reads every boundary in one call and keeps the view order', async () => {
    const calls: (readonly string[])[] = [];
    const read: DeploymentStepStampReader = (ids) => {
      calls.push(ids);
      return Promise.resolve(new Map([[ID_B, STAMPS]]));
    };
    const views = await attachDeploymentSteps(read, [view({ status: 'QUEUED', startedAt: null, completedAt: null }), view({ id: ID_B })]);
    expect(calls).toEqual([[ID_A, ID_B]]);
    expect(views.map((v) => v.id)).toEqual([ID_A, ID_B]);
    expect(views[0]?.steps.every((step) => step.state === 'pending')).toBe(true);
    expect(views[1]?.steps.every((step) => step.durationMs !== null)).toBe(true);
  });

  it('attaches steps to a single view', async () => {
    const read: DeploymentStepStampReader = () => Promise.resolve(new Map([[ID_A, STAMPS]]));
    const one = await attachDeploymentStepsTo(read, view());
    expect(one.steps).toHaveLength(4);
    expect(one.id).toBe(ID_A);
  });
});
