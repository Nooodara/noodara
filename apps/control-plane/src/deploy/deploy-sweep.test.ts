// 12-13 (A4): the startup sweep ends crashed deployments and cleans only per-deployment resources.
import { createRedactor } from '@noodara/domain/security';
import { deployWorkspaceFor, validateResourceId } from '@noodara/domain/validators';
import type { RemoteCommand, SshDeploySession, StreamResult } from '@noodara/ssh';
import { describe, expect, it, vi } from 'vitest';
import { sweepCrashedDeployments, type DeploySweepDeps } from './deploy-sweep.js';
import type { FinishDeploymentInput, InFlightDeployment } from './deployment-store.js';
import { DEPLOY_MESSAGES } from './run-deployment.js';

const SERVICE_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const DEPLOYMENT_ID = '3f2b8c1e-9d4a-4f6b-8a2c-1e5d7f9b0c3a';
const OTHER_DEPLOYMENT_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const SERVER_ID = '5d6e7f80-1a2b-4c3d-8e4f-5a6b7c8d9e0f';
const RAW = 'connect ECONNREFUSED postgres://noodara:pw@db:5432';

function workspaceOf(id: string) {
  const valid = validateResourceId(id);
  if (!valid.ok) throw new Error('fixture');
  const workspace = deployWorkspaceFor(valid.value);
  if (!workspace.ok) throw new Error('fixture');
  return workspace.value;
}

function recordingSession(groupAliveExit = 1) {
  const commands: RemoteCommand[] = [];
  const session = {
    exec: () => Promise.reject(new Error('unused')),
    close: () => Promise.resolve(),
    stream: (command: RemoteCommand): Promise<StreamResult> => {
      commands.push(command);
      return Promise.resolve({
        commandName: command.name,
        outcome: 'completed',
        exitCode: command.name === 'process.group_alive' ? groupAliveExit : 0,
        exitSignal: null,
        durationMs: 1,
        totalBytes: 0,
        truncated: false,
        stdoutTail: '',
        stderrTail: '',
      });
    },
  } as unknown as SshDeploySession;
  return { session, commands };
}

function harness(rows: InFlightDeployment[], overrides: Partial<DeploySweepDeps> = {}) {
  const finished: [string, FinishDeploymentInput][] = [];
  const logs: { level: string; fields: Record<string, unknown>; message: string }[] = [];
  const remote = recordingSession();
  const close = vi.fn(() => Promise.resolve());
  const deps: DeploySweepDeps = {
    store: {
      inFlight: () => Promise.resolve(rows),
      finish: vi.fn((id: string, input: FinishDeploymentInput) => {
        finished.push([id, input]);
        return Promise.resolve({ id } as never);
      }),
    },
    connect: vi.fn(() => Promise.resolve({ ok: true as const, session: remote.session, close })),
    createRedactor,
    limits: { killConfirmMs: 300, killPollMs: 50, cleanupStepMs: 1_000, maxLineBytes: 16_384 },
    logger: {
      info: (fields, message) => void logs.push({ level: 'info', fields, message }),
      warn: (fields, message) => void logs.push({ level: 'warn', fields, message }),
      error: (fields, message) => void logs.push({ level: 'error', fields, message }),
    },
    ...overrides,
  };
  return { deps, finished, logs, remote, close };
}

const row = (overrides: Partial<InFlightDeployment> = {}): InFlightDeployment => ({
  deploymentId: DEPLOYMENT_ID,
  serviceId: SERVICE_ID,
  serverId: SERVER_ID,
  status: 'BUILDING',
  ...overrides,
});

describe('sweepCrashedDeployments (A4)', () => {
  it('ends every in-flight deployment FAILED / WORKER_CRASHED before any remote work', async () => {
    const h = harness([row(), row({ deploymentId: OTHER_DEPLOYMENT_ID, status: 'DEPLOYING' })]);

    const result = await sweepCrashedDeployments(h.deps);

    expect(result.swept).toEqual([DEPLOYMENT_ID, OTHER_DEPLOYMENT_ID]);
    expect(h.finished).toEqual([
      [DEPLOYMENT_ID, { status: 'FAILED', errorCode: 'WORKER_CRASHED', errorMessage: DEPLOY_MESSAGES.WORKER_CRASHED, commitSha: null, container: null }],
      [OTHER_DEPLOYMENT_ID, expect.objectContaining({ errorCode: 'WORKER_CRASHED' }) as unknown],
    ]);
    await result.cleanup;
  });

  it('kills leftover supervised groups, removes the workspace and the deployment image, never the container or network', async () => {
    const h = harness([row()]);

    await (await sweepCrashedDeployments(h.deps)).cleanup;

    const names = h.remote.commands.map((command) => command.name);
    expect(names.filter((name) => name === 'process.kill_group')).toHaveLength(3);
    expect(names.slice(-2)).toEqual(['fs.remove_deploy_dir', 'docker.image_remove']);
    expect(h.remote.commands.at(-1)?.argv).toContain(`noodara/${SERVICE_ID}:${DEPLOYMENT_ID}`);
    const all = h.remote.commands.flatMap((command) => [...command.argv]).join(' ');
    for (const op of ['clone', 'build', 'pull'] as const) expect(all).toContain(workspaceOf(DEPLOYMENT_ID).pidFile(op));
    expect(names.some((name) => /docker\.(stop|rm|remove|network_remove|kill)$/.test(name) && name !== 'docker.image_remove')).toBe(false);
    expect(all).not.toMatch(/-f\b|--force/);
    expect(h.close).toHaveBeenCalledOnce();
  });

  it('never kills a runtime log follow (12-16): only deployment operations are swept', async () => {
    const h = harness([row()]);

    await (await sweepCrashedDeployments(h.deps)).cleanup;

    const all = h.remote.commands.flatMap((command) => [...command.argv]).join(' ');
    expect(all).not.toContain(workspaceOf(DEPLOYMENT_ID).pidFile('logs'));
  });

  it('skips a row that turned terminal meanwhile: no cleanup of resources it does not own', async () => {
    const h = harness([row()], {
      store: { inFlight: () => Promise.resolve([row()]), finish: () => Promise.resolve(null) },
    });

    const result = await sweepCrashedDeployments(h.deps);
    await result.cleanup;

    expect(result.swept).toEqual([]);
    expect(h.deps.connect).not.toHaveBeenCalled();
  });

  it('never throws: an unreachable database, server or a failing finish is logged by kind only', async () => {
    const down = harness([], { store: { inFlight: () => Promise.reject(new Error(RAW)), finish: () => Promise.resolve(null) } });
    await expect(sweepCrashedDeployments(down.deps)).resolves.toMatchObject({ swept: [] });

    const failing = harness([row()], {
      connect: () => Promise.reject(new Error(RAW)),
      store: { inFlight: () => Promise.resolve([row(), row({ deploymentId: OTHER_DEPLOYMENT_ID })]), finish: vi.fn().mockRejectedValueOnce(new Error(RAW)).mockResolvedValue({}) },
    });
    const result = await sweepCrashedDeployments(failing.deps);
    await expect(result.cleanup).resolves.toBeUndefined();
    expect(result.swept).toEqual([OTHER_DEPLOYMENT_ID]);

    const unreachable = harness([row()], { connect: () => Promise.resolve({ ok: false as const, code: 'SERVER_UNREACHABLE' as const }) });
    await (await sweepCrashedDeployments(unreachable.deps)).cleanup;

    expect(JSON.stringify([down.logs, failing.logs, unreachable.logs])).not.toContain('pw@db');
    expect(unreachable.logs.some((log) => log.fields.code === 'SERVER_UNREACHABLE')).toBe(true);
  });

  it('an unconfirmed leftover process is logged and the cleanup still runs', async () => {
    const remote = recordingSession(0);
    const h = harness([row()], { connect: () => Promise.resolve({ ok: true as const, session: remote.session, close: () => Promise.resolve() }) });

    await (await sweepCrashedDeployments(h.deps)).cleanup;

    expect(h.logs.filter((log) => log.message.includes('could not confirm'))).toHaveLength(3);
    expect(remote.commands.at(-1)?.name).toBe('docker.image_remove');
  });
});
