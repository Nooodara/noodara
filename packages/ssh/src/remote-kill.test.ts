// Scripted-session unit tests for the confirmed remote kill (11-14, D-04, ADR 0008 G2, T-11-41).
// The real-process proof lives in tests/integration/deploy-engine/exec-streaming.test.ts.
import { createRedactor } from '@noodara/domain/security';
import { deployWorkspaceFor, type ContainerName, type DeployRunPath } from '@noodara/domain/validators';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderRemoteCommand, type DeployCommandName, type RemoteCommand } from './commands/index.js';
import { dockerKill } from './commands/docker-deploy.js';
import { groupAlive, killGroup } from './commands/workspace.js';
import { DOCKER_KILL_GRACE_MS, killSupervisedOperation } from './remote-kill.js';
import type { ExecResult, SshDeploySession, StreamOptions, StreamResult } from './ssh-port.js';

type Reply = Partial<Pick<StreamResult, 'outcome' | 'exitCode'>> | Error;

const CONTAINER = 'noodara-build-3f2b8c1e' as ContainerName;

function pidFile(): DeployRunPath {
  const ws = deployWorkspaceFor('3f2b8c1e-9d4a-4f6b-8a2c-1e5d7f9b0c3a');
  if (!ws.ok) throw new Error('test setup: workspace');
  return ws.value.pidFile('build');
}

/** Replies per command name, consumed in order; the last reply repeats. */
class ScriptedSession implements SshDeploySession {
  readonly calls: { command: RemoteCommand; options: StreamOptions; at: number }[] = [];
  private readonly replies: Partial<Record<DeployCommandName, Reply[]>>;

  constructor(replies: Partial<Record<DeployCommandName, Reply[]>>) {
    this.replies = replies;
  }

  exec(): Promise<ExecResult> {
    return Promise.reject(new Error('not used'));
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  stream(command: RemoteCommand, options: StreamOptions): Promise<StreamResult> {
    this.calls.push({ command, options, at: Date.now() });
    const queue = this.replies[command.name] ?? [{}];
    const reply = (queue.length > 1 ? queue.shift() : queue[0]) ?? {};
    if (reply instanceof Error) return Promise.reject(reply);
    return Promise.resolve({
      commandName: command.name,
      outcome: reply.outcome ?? 'completed',
      exitCode: reply.exitCode === undefined ? 0 : reply.exitCode,
      exitSignal: null,
      durationMs: 1,
      totalBytes: 0,
      truncated: false,
      stdoutTail: '',
      stderrTail: '',
    });
  }

  names(): DeployCommandName[] {
    return this.calls.map((call) => call.command.name);
  }
}

function run(
  session: SshDeploySession,
  overrides: { buildContainer?: ContainerName | null; confirmTimeoutMs?: number; pollIntervalMs?: number } = {},
) {
  return killSupervisedOperation({
    session,
    pidFile: pidFile(),
    buildContainer: overrides.buildContainer ?? null,
    confirmTimeoutMs: overrides.confirmTimeoutMs ?? 10_000,
    pollIntervalMs: overrides.pollIntervalMs ?? 100,
    redactor: createRedactor(),
  });
}

async function settle<T>(promise: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return promise;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('killSupervisedOperation (D-04, ADR 0008 G2)', () => {
  it('kills the group and confirms when process.group_alive exits 1 on the first poll', async () => {
    const session = new ScriptedSession({ 'process.group_alive': [{ exitCode: 1 }] });

    const result = await settle(run(session));

    expect(result).toMatchObject({ confirmed: true, steps: ['kill_group'] });
    expect(session.names()).toEqual(['process.kill_group', 'process.group_alive']);
    expect(session.calls.map((call) => renderRemoteCommand(call.command))).toEqual([
      renderRemoteCommand(killGroup(pidFile())),
      renderRemoteCommand(groupAlive(pidFile())),
    ]);
  });

  it('polls every pollIntervalMs until the group is absent', async () => {
    const session = new ScriptedSession({
      'process.group_alive': [{ exitCode: 0 }, { exitCode: 0 }, { exitCode: 1 }],
    });

    const result = await settle(run(session, { pollIntervalMs: 250 }));

    const polls = session.calls.filter((call) => call.command.name === 'process.group_alive');
    expect(result.confirmed).toBe(true);
    expect(polls.map((call) => call.at - (session.calls[0]?.at ?? 0))).toEqual([0, 250, 500]);
    expect(result.elapsedMs).toBe(500);
  });

  it('confirms even when kill_group itself fails because the group is already gone', async () => {
    const session = new ScriptedSession({
      'process.kill_group': [{ exitCode: 1 }],
      'process.group_alive': [{ exitCode: 1 }],
    });

    expect((await settle(run(session))).confirmed).toBe(true);
  });

  it('docker kills the build container once when the group is still alive after the grace period', async () => {
    const session = new ScriptedSession({
      'process.group_alive': [...Array.from({ length: 21 }, () => ({ exitCode: 0 })), { exitCode: 1 }],
    });

    const result = await settle(run(session, { buildContainer: CONTAINER, pollIntervalMs: 100 }));

    const dockerCalls = session.calls.filter((call) => call.command.name === 'docker.kill');
    expect(result).toMatchObject({ confirmed: true, steps: ['kill_group', 'docker_kill'] });
    expect(dockerCalls).toHaveLength(1);
    expect(renderRemoteCommand(dockerCalls[0]?.command ?? killGroup(pidFile()))).toBe(
      renderRemoteCommand(dockerKill(CONTAINER)),
    );
    expect(dockerCalls[0]?.at).toBeGreaterThanOrEqual(DOCKER_KILL_GRACE_MS);
    // Confirmation still comes only from process.group_alive.
    expect(session.names().at(-1)).toBe('process.group_alive');
  });

  it('never docker kills before the grace period or without a container', async () => {
    const early = new ScriptedSession({
      'process.group_alive': [{ exitCode: 0 }, { exitCode: 0 }, { exitCode: 1 }],
    });
    const noContainer = new ScriptedSession({ 'process.group_alive': [{ exitCode: 0 }] });

    await settle(run(early, { buildContainer: CONTAINER }));
    const unconfirmed = await settle(run(noContainer, { confirmTimeoutMs: 5_000 }));

    expect(early.names()).not.toContain('docker.kill');
    expect(noContainer.names()).not.toContain('docker.kill');
    expect(unconfirmed).toMatchObject({ confirmed: false, steps: ['kill_group'] });
  });

  it('reports confirmed false once confirmTimeoutMs elapses with the group still alive', async () => {
    const session = new ScriptedSession({ 'process.group_alive': [{ exitCode: 0 }] });

    const result = await settle(run(session, { buildContainer: CONTAINER, confirmTimeoutMs: 3_000 }));

    expect(result).toMatchObject({ confirmed: false, steps: ['kill_group', 'docker_kill'] });
    expect(result.elapsedMs).toBeGreaterThanOrEqual(3_000);
    expect(result.elapsedMs).toBeLessThan(3_000 + 100 + 1);
  });

  it('never counts an unknown group_alive answer (missing pidfile exit 2, timeout, no exit code) as absent', async () => {
    for (const reply of [
      { exitCode: 2 },
      { exitCode: null },
      { outcome: 'timed_out' as const, exitCode: null },
      { outcome: 'idle_timeout' as const, exitCode: 1 },
    ]) {
      const session = new ScriptedSession({ 'process.group_alive': [reply] });
      const result = await settle(run(session, { confirmTimeoutMs: 1_000 }));
      expect(result.confirmed).toBe(false);
    }
  });

  it('never throws: a failing stream yields confirmed false and no error text', async () => {
    const leaked = 'secret-in-error-message-123';
    const session = new ScriptedSession({ 'process.group_alive': [new Error(leaked)] });

    const result = await settle(run(session));

    expect(result).toMatchObject({ confirmed: false, steps: ['kill_group'] });
    expect(JSON.stringify(result)).not.toContain(leaked);
  });

  it('never throws when the kill itself fails', async () => {
    const session = new ScriptedSession({ 'process.kill_group': [new Error('transport lost')] });

    expect(await settle(run(session))).toMatchObject({ confirmed: false, steps: ['kill_group'] });
    expect(session.names()).toEqual(['process.kill_group']);
  });

  it.each([
    ['confirmTimeoutMs', { confirmTimeoutMs: 0 }],
    ['pollIntervalMs', { pollIntervalMs: -5 }],
  ] as const)('returns confirmed false for an invalid %s without running anything', async (_name, bad) => {
    const session = new ScriptedSession({});

    expect(await settle(run(session, bad))).toMatchObject({ confirmed: false, steps: [] });
    expect(session.calls).toHaveLength(0);
  });

  it('bounds every remote step by the remaining confirmation budget', async () => {
    const session = new ScriptedSession({ 'process.group_alive': [{ exitCode: 0 }] });

    await settle(run(session, { confirmTimeoutMs: 1_000, pollIntervalMs: 300 }));

    for (const call of session.calls) {
      expect(call.options.maxDurationMs).toBeGreaterThan(0);
      expect(call.options.maxDurationMs).toBeLessThanOrEqual(1_000);
      expect(call.options.idleTimeoutMs).toBeLessThanOrEqual(call.options.maxDurationMs);
      expect(call.options.stdin).toBeUndefined();
    }
  });
});
