import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderUi, screen, waitFor, within } from '@noodara/ui/testing';
import type { DeploymentView } from '../lib/deploy-api';
import { DEPLOYMENT_ERROR_COPY, GENERIC_DEPLOYMENT_ERROR_COPY } from '../lib/deploy-error-copy';
import type { DeployEntityEvent } from '../lib/server-events';
import type { SyncStream } from '../lib/use-server-events';
import { DiscoveryStep } from './DiscoveryStep';
import {
  DeploymentSteps,
  useDeploymentSteps,
  type DeploymentStepView,
  type DeploymentWithSteps,
} from './DeploymentSteps';

const deployApi = vi.hoisted(() => ({
  getDeployment: vi.fn(),
  getConfigureNames: vi.fn(() => Promise.resolve({ ok: false, code: 'NOT_FOUND', message: 'x', unauthorized: false })),
}));
vi.mock('../lib/deploy-api', () => ({
  getDeployment: (id: string) => deployApi.getDeployment(id) as unknown,
  getConfigureNames: (id: string) => deployApi.getConfigureNames(id) as unknown,
}));
vi.mock('../lib/require-session', () => ({ requireSession: () => undefined }));

const DEPLOYMENT_ID = '77777777-7777-4777-8777-777777777777';
const OTHER_ID = '88888888-8888-4888-8888-888888888888';
const SERVICE_ID = '44444444-4444-4444-8444-444444444444';
const STAMP = '2026-10-06T00:00:00.000Z';
const LATER = '2026-10-06T00:05:00.000Z';
const RAW_MESSAGE = 'RAW-SERVER-MESSAGE fatal: could not read Username password=hunter2';

type StepTuple = readonly [DeploymentStepView['name'], DeploymentStepView['state'], number | null];

function steps(...tuples: StepTuple[]): DeploymentStepView[] {
  return tuples.map(([name, state, durationMs]) => ({
    name,
    state,
    startedAt: durationMs === null ? null : STAMP,
    completedAt: durationMs === null ? null : STAMP,
    durationMs,
  }));
}

function deployment(overrides: Partial<DeploymentWithSteps> = {}): DeploymentWithSteps {
  return {
    id: DEPLOYMENT_ID,
    serviceId: SERVICE_ID,
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
      publishedPort: null,
    },
    commitSha: null,
    previousDeploymentId: null,
    startedAt: STAMP,
    completedAt: STAMP,
    durationMs: 1000,
    errorCode: null,
    errorMessage: null,
    createdAt: STAMP,
    updatedAt: STAMP,
    steps: steps(['clone', 'success', 420], ['build', 'success', 12_300], ['start', 'success', 900], ['verify', 'success', 2100]),
    ...overrides,
  };
}

const ok = <T,>(data: T) => Promise.resolve({ ok: true, data });

describe('DeploymentSteps', () => {
  it('narrates clone, build, start, verify in order with state and duration (A1)', () => {
    renderUi(<DeploymentSteps deployment={deployment()} />);
    const rows = screen.getAllByTestId(/^deployment-step-/);
    expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual([
      'deployment-step-clone',
      'deployment-step-build',
      'deployment-step-start',
      'deployment-step-verify',
    ]);
    const build = screen.getByTestId('deployment-step-build');
    expect(within(build).getByText('Build')).toBeInTheDocument();
    expect(within(build).getByText('Done')).toBeInTheDocument();
    expect(within(build).getByTestId('step-duration')).toHaveTextContent('12.3s');
    expect(within(screen.getByTestId('deployment-step-clone')).getByTestId('step-duration')).toHaveTextContent('420ms');
  });

  it('narrates pull and a skipped build for an image source', () => {
    renderUi(
      <DeploymentSteps
        deployment={deployment({
          steps: steps(['pull', 'success', 800], ['build', 'skipped', null], ['start', 'running', null], ['verify', 'pending', null]),
          status: 'DEPLOYING',
        })}
      />,
    );
    expect(within(screen.getByTestId('deployment-step-pull')).getByText('Pull image')).toBeInTheDocument();
    const build = screen.getByTestId('deployment-step-build');
    expect(within(build).getByText('Skipped')).toBeInTheDocument();
    expect(within(build).queryByTestId('step-duration')).toBeNull();
    expect(within(screen.getByTestId('deployment-step-start')).getByText('Running')).toBeInTheDocument();
    expect(within(screen.getByTestId('deployment-step-verify')).getByText('Pending')).toBeInTheDocument();
  });

  it('23-04 A4: shows configure between clone and build with its counts, never a key or a reference', () => {
    const [clone, ...rest] = deployment().steps;
    if (clone === undefined) throw new Error('no clone step');
    const configure: DeploymentStepView = {
      name: 'configure',
      state: 'success',
      startedAt: STAMP,
      completedAt: STAMP,
      durationMs: 40,
      counts: { variables: 3, secrets: 1 },
    };
    renderUi(<DeploymentSteps deployment={deployment({ steps: [clone, configure, ...rest] })} />);
    expect(screen.getAllByTestId(/^deployment-step-/).map((row) => row.getAttribute('data-testid'))).toEqual([
      'deployment-step-clone',
      'deployment-step-configure',
      'deployment-step-build',
      'deployment-step-start',
      'deployment-step-verify',
    ]);
    const row = screen.getByTestId('deployment-step-configure');
    expect(within(row).getByText('Configure')).toBeInTheDocument();
    expect(within(row).getByTestId('step-duration')).toHaveTextContent('40ms');
    expect(within(row).getByTestId('deployment-configure-counts')).toHaveTextContent('3 variables, 1 secret');
  });

  it('23-04 A4: hides a skipped configure (no variables) and fails it on an unresolved secret', () => {
    const [clone, ...rest] = deployment().steps;
    if (clone === undefined) throw new Error('no clone step');
    const skipped = steps(['configure', 'skipped', null]);
    const { unmount } = renderUi(<DeploymentSteps deployment={deployment({ steps: [clone, ...skipped, ...rest] })} />);
    expect(screen.queryByTestId('deployment-step-configure')).toBeNull();
    expect(screen.getAllByTestId(/^deployment-step-/)).toHaveLength(4);
    unmount();

    renderUi(
      <DeploymentSteps
        deployment={deployment({
          status: 'FAILED',
          errorCode: 'SECRET_UNRESOLVED',
          steps: steps(['clone', 'pending', null], ['configure', 'failed', 30], ['build', 'pending', null], ['start', 'pending', null], ['verify', 'pending', null]),
        })}
      />,
    );
    const row = screen.getByTestId('deployment-step-configure');
    expect(within(row).getByText('Failed')).toBeInTheDocument();
    expect(within(row).queryByTestId('deployment-configure-counts')).toBeNull();
  });

  it('24-03 A2: configure shows variables, secrets and duration', () => {
    const configure: DeploymentStepView = {
      name: 'configure',
      state: 'success',
      startedAt: STAMP,
      completedAt: STAMP,
      durationMs: 1200,
      counts: { variables: 1, secrets: 2 },
    };
    renderUi(<DeploymentSteps deployment={deployment({ steps: [configure] })} />);
    const row = screen.getByTestId('deployment-step-configure');
    expect(within(row).getByTestId('deployment-configure-counts')).toHaveTextContent('1 variable, 2 secrets');
    expect(within(row).getByTestId('step-duration')).not.toHaveTextContent(/^$/);
  });

  it('24-03 A2: SECRET_UNRESOLVED recovery names the keys and references the configure step logged, never values', async () => {
    deployApi.getConfigureNames.mockResolvedValueOnce({
      ok: true,
      data: { keys: ['PORT', 'DATABASE_URL'], references: [{ key: 'DATABASE_URL', secret: 'db_password' }] },
    } as never);
    renderUi(
      <DeploymentSteps
        deployment={deployment({
          status: 'FAILED',
          errorCode: 'SECRET_UNRESOLVED',
          errorMessage: RAW_MESSAGE,
          steps: steps(['clone', 'success', 10], ['configure', 'failed', 30]),
        })}
      />,
    );
    const banner = screen.getByTestId('deployment-error');
    await waitFor(() => {
      expect(banner).toHaveTextContent('DATABASE_URL → <secret:db_password>');
    });
    expect(deployApi.getConfigureNames).toHaveBeenCalledWith(DEPLOYMENT_ID);
    expect(banner).not.toHaveTextContent('hunter2');
  });

  it('24-03 A2: ENV_INJECTION_FAILED names keys; PROXY_ROUTE_FAILED names the given hostnames without fetching', async () => {
    deployApi.getConfigureNames.mockResolvedValueOnce({ ok: true, data: { keys: ['PORT'], references: [] } } as never);
    const { unmount } = renderUi(
      <DeploymentSteps deployment={deployment({ status: 'FAILED', errorCode: 'ENV_INJECTION_FAILED', steps: steps(['configure', 'failed', 5]) })} />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('deployment-error')).toHaveTextContent('The variables PORT could not be written');
    });
    unmount();
    deployApi.getConfigureNames.mockClear();

    renderUi(
      <DeploymentSteps
        deployment={deployment({ status: 'FAILED', errorCode: 'PROXY_ROUTE_FAILED' })}
        errorContext={{ hostnames: ['app.example.com'] }}
      />,
    );
    expect(screen.getByTestId('deployment-error')).toHaveTextContent('routes for app.example.com');
    expect(deployApi.getConfigureNames).not.toHaveBeenCalled();
  });

  it('24-03 A2: keeps the plain recovery copy while names are unknown', () => {
    renderUi(<DeploymentSteps deployment={deployment({ status: 'FAILED', errorCode: 'SECRET_UNRESOLVED' })} />);
    expect(screen.getByTestId('deployment-error')).toHaveTextContent(DEPLOYMENT_ERROR_COPY.SECRET_UNRESOLVED.recovery);
  });

  it('reuses the discovery step row treatment instead of a copy (A1)', () => {
    renderUi(
      <>
        <DeploymentSteps deployment={deployment()} />
        <DiscoveryStep stepId="os" label="Operating system" state="pass" checks={[]} sshUser="deployer" />
      </>,
    );
    const deployRow = screen.getByTestId('deployment-step-clone');
    const discoveryRow = screen.getByTestId('discovery-step-os');
    expect(deployRow.getAttribute('data-step-row')).toBe('true');
    expect(discoveryRow.getAttribute('data-step-row')).toBe('true');
    expect(deployRow.className).toBe(discoveryRow.className);
    expect(deployRow.querySelector('.scale-y-100')).not.toBeNull();
    expect(within(deployRow).getByLabelText('Done').getAttribute('class')).toBe(
      within(discoveryRow).getByLabelText('Pass').getAttribute('class'),
    );
  });

  it('keeps the thread empty for unresolved steps and fills it for cancelled ones', () => {
    renderUi(
      <DeploymentSteps
        deployment={deployment({
          status: 'CANCELLED',
          steps: steps(['clone', 'success', 300], ['build', 'cancelled', 1200], ['start', 'pending', null], ['verify', 'pending', null]),
        })}
      />,
    );
    expect(within(screen.getByTestId('deployment-step-build')).getByText('Cancelled')).toBeInTheDocument();
    expect(screen.getByTestId('deployment-step-build').querySelector('.scale-y-100')).not.toBeNull();
    expect(screen.getByTestId('deployment-step-start').querySelector('.scale-y-0')).not.toBeNull();
  });

  // 13-20 A1: a caption-size status word in the plain semantic color fails AA in light
  // (--status-error on white is 3.54:1); words use the AA-tuned --status-*-text tokens, the icon
  // keeps the plain semantic color.
  it('renders each status word in its AA text token, never the plain semantic color', () => {
    renderUi(
      <DeploymentSteps
        deployment={deployment({
          status: 'FAILED',
          errorCode: 'BUILD_FAILED',
          steps: steps(['pull', 'failed', 800], ['build', 'skipped', null], ['start', 'pending', null], ['verify', 'pending', null]),
        })}
      />,
    );
    const cases = [
      ['deployment-step-pull', 'Failed', 'text-status-error-text'],
      ['deployment-step-build', 'Skipped', 'text-status-idle-text'],
      ['deployment-step-start', 'Pending', 'text-status-idle-text'],
    ] as const;
    for (const [testId, word, token] of cases) {
      const classes = (within(screen.getByTestId(testId)).getByText(word).getAttribute('class') ?? '').split(/\s+/);
      expect(classes).toContain(token);
      expect(classes.filter((name) => /^text-(status-(ok|warn|error|idle)|ink-tertiary)$/.test(name))).toEqual([]);
    }
    expect(within(screen.getByTestId('deployment-step-pull')).getByLabelText('Failed').getAttribute('class')).toContain(
      'text-status-error',
    );
  });

  // 13-20 A4: the thread used to span the whole row (inset-y-0 at the icon's center line), so it
  // ran straight through every step icon. Each segment now starts below its own icon, reaches
  // just short of the next row's icon, and the last row draws none.
  it('draws the thread between step icons, never through them', () => {
    renderUi(<DeploymentSteps deployment={deployment()} />);
    for (const row of screen.getAllByTestId(/^deployment-step-/)) {
      const thread = row.querySelector('[data-step-thread]');
      expect(thread).not.toBeNull();
      const classes = (thread?.getAttribute('class') ?? '').split(/\s+/);
      expect(classes).not.toContain('inset-y-0');
      expect(classes).toEqual(expect.arrayContaining(['top-8.5', '-bottom-2.5', 'group-last/step:hidden']));
      expect(row.className.split(/\s+/)).toContain('group/step');
    }
  });

  it('only animates the running indicator behind motion-safe, so reduced motion keeps it still (A4)', () => {
    renderUi(
      <DeploymentSteps
        deployment={deployment({
          status: 'BUILDING',
          steps: steps(['clone', 'success', 300], ['build', 'running', null], ['start', 'pending', null], ['verify', 'pending', null]),
        })}
      />,
    );
    const icon = screen.getByLabelText('Running');
    const classes = (icon.getAttribute('class') ?? '').split(/\s+/);
    expect(classes).toContain('motion-safe:animate-pulse');
    expect(classes.filter((name) => name.includes('animate') && !name.startsWith('motion-safe:'))).toEqual([]);
    for (const element of screen.getByTestId('deployment-steps').querySelectorAll('[class]')) {
      const names = (element.getAttribute('class') ?? '').split(/\s+/);
      expect(names.filter((name) => /(^|:)(animate-|transition)/.test(name) && !name.startsWith('motion-safe:'))).toEqual([]);
    }
  });

  it('shows the classified copy for a failed deploy and never the raw errorMessage (A2, A3)', () => {
    renderUi(
      <DeploymentSteps
        deployment={deployment({
          status: 'FAILED',
          errorCode: 'BUILD_FAILED',
          errorMessage: RAW_MESSAGE,
          steps: steps(['clone', 'success', 300], ['build', 'failed', 5000], ['start', 'pending', null], ['verify', 'pending', null]),
        })}
      />,
    );
    const error = screen.getByTestId('deployment-error');
    expect(within(error).getByText(DEPLOYMENT_ERROR_COPY.BUILD_FAILED.title)).toBeInTheDocument();
    expect(within(error).getByText(DEPLOYMENT_ERROR_COPY.BUILD_FAILED.recovery)).toBeInTheDocument();
    expect(within(error).getByText('BUILD_FAILED')).toBeInTheDocument();
    expect(within(screen.getByTestId('deployment-step-build')).getByText('Failed')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('RAW-SERVER-MESSAGE');
    expect(document.body.innerHTML).not.toContain('hunter2');
  });

  it('falls back to the generic copy for an unknown code, without echoing it or the message (H1)', () => {
    renderUi(
      <DeploymentSteps
        deployment={deployment({
          status: 'FAILED',
          errorCode: 'FUTURE_CODE_<b>x</b>' as DeploymentView['errorCode'],
          errorMessage: RAW_MESSAGE,
          steps: steps(['clone', 'failed', 300], ['build', 'pending', null], ['start', 'pending', null], ['verify', 'pending', null]),
        })}
      />,
    );
    const error = screen.getByTestId('deployment-error');
    expect(within(error).getByText(GENERIC_DEPLOYMENT_ERROR_COPY.title)).toBeInTheDocument();
    expect(within(error).getByText(GENERIC_DEPLOYMENT_ERROR_COPY.recovery)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('FUTURE_CODE');
    expect(document.body.textContent).not.toContain('undefined');
    expect(document.body.textContent).not.toContain('RAW-SERVER-MESSAGE');
  });

  it('adds a running Rollback row while ROLLING_BACK (A1)', () => {
    renderUi(
      <DeploymentSteps
        deployment={deployment({
          status: 'ROLLING_BACK',
          errorCode: 'HEALTHCHECK_FAILED',
          steps: steps(['clone', 'success', 420], ['build', 'success', 12_300], ['start', 'success', 900], ['verify', 'failed', 2100]),
        })}
      />,
    );
    const row = screen.getByTestId('deployment-step-rollback');
    expect(row.getAttribute('data-severity')).toBe('running');
    expect(within(screen.getByTestId('deployment-step-verify')).getByText('Health check')).toBeTruthy();
  });

  it('names the restored commit once ROLLED_BACK (A1)', async () => {
    const PREVIOUS = '99999999-9999-4999-8999-999999999999';
    deployApi.getDeployment.mockReturnValue(ok(deployment({ id: PREVIOUS, commitSha: 'abcdef1234567890' })));
    renderUi(
      <DeploymentSteps
        deployment={deployment({
          status: 'ROLLED_BACK',
          errorCode: 'HEALTHCHECK_TIMEOUT',
          previousDeploymentId: PREVIOUS,
          steps: steps(['clone', 'success', 420], ['build', 'success', 12_300], ['start', 'success', 900], ['verify', 'failed', 2100]),
        })}
      />,
    );
    expect(screen.getByTestId('deployment-step-rollback').getAttribute('data-severity')).toBe('pass');
    await waitFor(() => {
      expect(screen.getByTestId('deployment-rollback-commit').textContent).toContain('abcdef1');
    });
    expect(screen.getByTestId('deployment-error')).toBeTruthy();
  });

  it('shows the rollback duration when the steps and the deployment end are known (A4)', () => {
    const base = steps(['clone', 'success', 420], ['build', 'success', 12_300], ['start', 'success', 900], ['verify', 'failed', 2100]);
    const verify = base.map((step) => (step.name === 'verify' ? { ...step, completedAt: '2026-10-06T00:00:10.000Z' } : step));
    renderUi(
      <DeploymentSteps
        deployment={deployment({
          status: 'ROLLED_BACK',
          errorCode: 'HEALTHCHECK_TIMEOUT',
          completedAt: '2026-10-06T00:00:14.000Z',
          steps: verify,
        })}
      />,
    );
    expect(within(screen.getByTestId('deployment-step-rollback')).getByText('4.0s')).toBeTruthy();
  });

  it('shows a failed Rollback row for ROLLBACK_FAILED and none for a plain failure', () => {
    const { unmount } = renderUi(<DeploymentSteps deployment={deployment({ status: 'FAILED', errorCode: 'ROLLBACK_FAILED' })} />);
    expect(screen.getByTestId('deployment-step-rollback').getAttribute('data-severity')).toBe('fail');
    unmount();
    renderUi(<DeploymentSteps deployment={deployment({ status: 'FAILED', errorCode: 'BUILD_FAILED' })} />);
    expect(screen.queryByTestId('deployment-step-rollback')).toBeNull();
  });

  it('renders unknown step names, states and statuses without throwing (H1)', () => {
    const odd = deployment({
      status: 'QUANTUM' as never,
      steps: [{ name: 'teleport' as never, state: 'hovering' as never, startedAt: null, completedAt: null, durationMs: null }],
    });
    renderUi(<DeploymentSteps deployment={odd} />);
    expect(screen.getByTestId('deployment-step-teleport')).toBeTruthy();
    expect(screen.queryByText(/QUANTUM/)).toBeNull();
  });

  it('shows no error block for a successful deploy', () => {
    renderUi(<DeploymentSteps deployment={deployment({ errorMessage: RAW_MESSAGE })} />);
    expect(screen.queryByTestId('deployment-error')).toBeNull();
    expect(document.body.textContent).not.toContain('RAW-SERVER-MESSAGE');
  });

  it('renders the guarded last log lines as text, masked and capped (H1)', () => {
    const canary = `noodara-canary-build-${'0f'.repeat(16)}`;
    const tail = ['Step 4/6 : RUN npm ci', `echo ${canary}`, '<img src=x onerror="alert(1)">', 'npm ERR! code ELIFECYCLE', ''].join('\n');
    renderUi(
      <DeploymentSteps
        deployment={deployment({
          status: 'FAILED',
          errorCode: 'BUILD_FAILED',
          steps: steps(['clone', 'success', 300], ['build', 'failed', 5000], ['start', 'pending', null], ['verify', 'pending', null]),
        })}
        logTail={tail}
      />,
    );
    const lines = screen.getByTestId('deployment-error-log');
    expect(lines.textContent).toContain('npm ERR! code ELIFECYCLE');
    expect(lines.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(lines.querySelector('img')).toBeNull();
    expect(document.body.innerHTML).not.toContain(canary);
    expect(lines.textContent).toContain('[REDACTED]');
  });

  it('shows no log block when the tail is empty', () => {
    renderUi(
      <DeploymentSteps
        deployment={deployment({ status: 'FAILED', errorCode: 'START_FAILED' })}
        logTail={'\n\n'}
      />,
    );
    expect(screen.queryByTestId('deployment-error-log')).toBeNull();
  });
});

describe('useDeploymentSteps', () => {
  const listeners = new Set<(event: DeployEntityEvent) => void>();
  const resyncs = new Set<() => void>();
  const stream: SyncStream = {
    subscribeDeploy: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    registerResync: (callback) => {
      resyncs.add(callback);
      return () => {
        resyncs.delete(callback);
      };
    },
  };

  function updated(id: string, status: DeploymentView['status'], updatedAt = LATER): DeployEntityEvent {
    return {
      type: 'deployment.updated',
      deployment: { id, serviceId: SERVICE_ID, status, errorCode: null, updatedAt },
    };
  }

  function emit(event: DeployEntityEvent) {
    act(() => {
      for (const listener of listeners) listener(event);
    });
  }

  beforeEach(() => {
    listeners.clear();
    resyncs.clear();
    deployApi.getDeployment.mockReset();
  });

  it('is null without a deployment', () => {
    const { result } = renderHook(() => useDeploymentSteps(null, stream));
    expect(result.current).toBeNull();
    expect(deployApi.getDeployment).not.toHaveBeenCalled();
  });

  it('loads the deployment with its steps and refetches on its deployment.updated (A5)', async () => {
    const building = deployment({
      status: 'BUILDING',
      steps: steps(['clone', 'success', 300], ['build', 'running', null], ['start', 'pending', null], ['verify', 'pending', null]),
    });
    const deploying = deployment({
      status: 'DEPLOYING',
      updatedAt: LATER,
      steps: steps(['clone', 'success', 300], ['build', 'success', 4000], ['start', 'running', null], ['verify', 'pending', null]),
    });
    deployApi.getDeployment.mockImplementationOnce(() => ok(building)).mockImplementationOnce(() => ok(deploying));
    const { result } = renderHook(() => useDeploymentSteps(DEPLOYMENT_ID, stream));
    await waitFor(() => {
      expect(result.current?.status).toBe('BUILDING');
    });
    emit(updated(OTHER_ID, 'FAILED'));
    expect(deployApi.getDeployment).toHaveBeenCalledTimes(1);
    emit(updated(DEPLOYMENT_ID, 'DEPLOYING'));
    await waitFor(() => {
      expect(result.current?.steps[2]?.state).toBe('running');
    });
    expect(deployApi.getDeployment).toHaveBeenLastCalledWith(DEPLOYMENT_ID);
  });

  it('shows the seed while loading and keeps a newer view over an older response', async () => {
    const newer = deployment({ status: 'SUCCESS', updatedAt: LATER });
    const older = deployment({ status: 'BUILDING', updatedAt: STAMP });
    deployApi.getDeployment.mockImplementation(() => ok(older));
    const { result } = renderHook(() => useDeploymentSteps(DEPLOYMENT_ID, stream, newer));
    expect(result.current?.status).toBe('SUCCESS');
    await waitFor(() => {
      expect(deployApi.getDeployment).toHaveBeenCalled();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current?.status).toBe('SUCCESS');
  });

  it('ignores a seed without steps and a response for a deployment no longer shown', async () => {
    let resolveFirst: (value: unknown) => void = () => undefined;
    deployApi.getDeployment
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(() => ok(deployment({ id: OTHER_ID, status: 'QUEUED' })));
    const seedWithoutSteps = { ...deployment(), steps: undefined } as unknown as DeploymentView;
    const { result, rerender } = renderHook(({ id }) => useDeploymentSteps(id, stream, seedWithoutSteps), {
      initialProps: { id: DEPLOYMENT_ID },
    });
    expect(result.current).toBeNull();
    rerender({ id: OTHER_ID });
    await waitFor(() => {
      expect(result.current?.id).toBe(OTHER_ID);
    });
    await act(async () => {
      resolveFirst({ ok: true, data: deployment({ status: 'FAILED' }) });
      await Promise.resolve();
    });
    expect(result.current?.id).toBe(OTHER_ID);
  });

  it('refetches on stream resync and keeps what is shown when a refetch fails', async () => {
    deployApi.getDeployment
      .mockImplementationOnce(() => ok(deployment()))
      .mockImplementationOnce(() => Promise.resolve({ ok: false, code: 'NETWORK_ERROR', message: 'x', unauthorized: false }));
    const { result } = renderHook(() => useDeploymentSteps(DEPLOYMENT_ID, stream));
    await waitFor(() => {
      expect(result.current?.status).toBe('SUCCESS');
    });
    act(() => {
      for (const resync of resyncs) resync();
    });
    await waitFor(() => {
      expect(deployApi.getDeployment).toHaveBeenCalledTimes(2);
    });
    expect(result.current?.status).toBe('SUCCESS');
  });
});
