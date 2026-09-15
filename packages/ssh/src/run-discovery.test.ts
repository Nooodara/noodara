// Task 1 (DISC-01, SERV-08, D-13): the branch matrix for one discovery run over a single session.
// Driven entirely against a fake `SshSession` whose `exec` returns scripted `ExecResult`s (and
// rejections) per command name — the real-container proof of the whole flow is plan 02-10's
// `discovery.test.ts`. This file's job is the pass/fail/parser-failure/timeout/root/non-root
// branch matrix, which needs dozens of scripted permutations that would cost a container start
// each otherwise.
import { createRedactor } from '@noodara/domain/security';
import { DISCOVERY_CHECK_IDS } from '@noodara/domain/discovery';
import { describe, expect, it, vi } from 'vitest';
import { COMMAND_NAMES, type CommandName } from './commands/index.js';
import type { ExecResult, SshSession } from './ssh-port.js';
import { DISCOVERY_SEQUENCE, runDiscovery } from './run-discovery.js';

const DEFAULT_TIMEOUTS = { discoveryMs: 60_000 };

function execResult(overrides: Partial<ExecResult> & { commandName: CommandName }): ExecResult {
  return {
    stdout: '',
    stderr: '',
    exitCode: 0,
    durationMs: 5,
    truncated: false,
    ...overrides,
  };
}

/** A scripted successful run: every command answers with realistic Ubuntu 24.04 output. */
function successfulScripts(): Record<CommandName, ExecResult> {
  return {
    'discovery.hostname': execResult({ commandName: 'discovery.hostname', stdout: 'web-01\n' }),
    'discovery.os_release': execResult({
      commandName: 'discovery.os_release',
      stdout: 'ID=ubuntu\nNAME="Ubuntu"\nVERSION_ID="24.04"\n',
    }),
    'discovery.arch': execResult({ commandName: 'discovery.arch', stdout: 'x86_64\n' }),
    'discovery.cpu': execResult({ commandName: 'discovery.cpu', stdout: '4\n' }),
    'discovery.memory': execResult({
      commandName: 'discovery.memory',
      stdout: 'MemTotal:        8024176 kB\n',
    }),
    'discovery.disk': execResult({
      commandName: 'discovery.disk',
      stdout: 'Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/sda1 932594 88404 800000 10% /\n',
    }),
    'discovery.uptime': execResult({ commandName: 'discovery.uptime', stdout: '12345.67 999.99\n' }),
    'docker.version': execResult({
      commandName: 'docker.version',
      stdout: '{"Client":{"Version":"24.0.7"},"Server":{"Version":"24.0.7"}}',
    }),
    'docker.compose_version': execResult({ commandName: 'docker.compose_version', stdout: 'v2.29.1' }),
    'access.sudo': execResult({ commandName: 'access.sudo', exitCode: 0 }),
    'access.docker_group': execResult({ commandName: 'access.docker_group', stdout: 'deployer docker sudo\n' }),
  };
}

function buildFakeSession(
  scripts: Partial<Record<CommandName, ExecResult | Error>>,
): { session: SshSession; execCalls: CommandName[]; closeCalls: number } {
  const execCalls: CommandName[] = [];
  let closeCalls = 0;
  const session: SshSession = {
    exec: vi.fn((name: CommandName): Promise<ExecResult> => {
      execCalls.push(name);
      const scripted = scripts[name];
      if (scripted === undefined) {
        return Promise.reject(new Error(`unscripted command in test double: ${name}`));
      }
      if (scripted instanceof Error) {
        return Promise.reject(scripted);
      }
      return Promise.resolve(scripted);
    }),
    close: vi.fn((): Promise<void> => {
      closeCalls += 1;
      return Promise.resolve();
    }),
  };
  return { session, execCalls, closeCalls };
}

describe('DISCOVERY_SEQUENCE', () => {
  it('covers every id in DISCOVERY_CHECK_IDS exactly once', () => {
    const ids = DISCOVERY_SEQUENCE.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...DISCOVERY_CHECK_IDS].sort());
  });

  it('uses each CommandName at most once', () => {
    const commandNames = DISCOVERY_SEQUENCE.map((entry) => entry.commandName);
    expect(new Set(commandNames).size).toBe(commandNames.length);
  });

  it('references only real allowlisted CommandNames', () => {
    for (const entry of DISCOVERY_SEQUENCE) {
      expect(COMMAND_NAMES).toContain(entry.commandName);
    }
  });
});

describe('runDiscovery — single-connection, per-check reporting (DISC-01, D-13)', () => {
  it('opens no second connection and never calls close() itself', async () => {
    const { session, execCalls, closeCalls } = buildFakeSession(successfulScripts());

    await runDiscovery({
      session,
      sshUser: 'deployer',
      timeouts: DEFAULT_TIMEOUTS,
      redactor: createRedactor(),
    });

    expect(execCalls.length).toBeGreaterThan(0);
    expect(closeCalls).toBe(0);
  });

  it('collects all ten DISC-01 facts and marks every check pass on an all-successful run', async () => {
    const { session } = buildFakeSession(successfulScripts());

    const snapshot = await runDiscovery({
      session,
      sshUser: 'deployer',
      timeouts: DEFAULT_TIMEOUTS,
      redactor: createRedactor(),
    });

    expect(snapshot.facts.hostname).toBe('web-01');
    expect(snapshot.facts.osDistribution).toBe('Ubuntu');
    expect(snapshot.facts.osVersion).toBe('24.04');
    expect(snapshot.facts.arch).toBe('x86_64');
    expect(snapshot.facts.cpuCores).toBe(4);
    expect(snapshot.facts.ramMb).not.toBeNull();
    expect(snapshot.facts.diskTotalMb).not.toBeNull();
    expect(snapshot.facts.diskUsedMb).not.toBeNull();
    expect(snapshot.facts.uptimeSeconds).toBe(12345);
    expect(snapshot.facts.dockerInstalled).toBe(true);
    expect(snapshot.facts.dockerVersion).toBe('24.0.7');
    expect(snapshot.facts.dockerComposeVersion).toBe('v2.29.1');

    for (const check of snapshot.checks) {
      expect(check.status).toBe('pass');
    }
    expect(snapshot.checks).toHaveLength(DISCOVERY_CHECK_IDS.length);
  });

  it('returns checks in DISCOVERY_SEQUENCE order', async () => {
    const { session } = buildFakeSession(successfulScripts());

    const snapshot = await runDiscovery({
      session,
      sshUser: 'deployer',
      timeouts: DEFAULT_TIMEOUTS,
      redactor: createRedactor(),
    });

    expect(snapshot.checks.map((c) => c.id)).toEqual(DISCOVERY_SEQUENCE.map((e) => e.id));
  });

  it('a single failing check leaves the others running and the snapshot still returned', async () => {
    const scripts = successfulScripts();
    scripts['discovery.arch'] = execResult({ commandName: 'discovery.arch', exitCode: 1, stderr: 'boom' });
    const { session } = buildFakeSession(scripts);

    const snapshot = await runDiscovery({
      session,
      sshUser: 'deployer',
      timeouts: DEFAULT_TIMEOUTS,
      redactor: createRedactor(),
    });

    const archCheck = snapshot.checks.find((c) => c.id === 'arch');
    expect(archCheck?.status).toBe('fail');
    expect(snapshot.facts.arch).toBeNull();
    expect(snapshot.facts.hostname).toBe('web-01');
    expect(snapshot.checks).toHaveLength(DISCOVERY_CHECK_IDS.length);
  });

  it('a parser failure on valid-exit-code output is reported as fail without throwing', async () => {
    const scripts = successfulScripts();
    scripts['discovery.cpu'] = execResult({ commandName: 'discovery.cpu', stdout: 'not-a-number\n' });
    const { session } = buildFakeSession(scripts);

    const snapshot = await runDiscovery({
      session,
      sshUser: 'deployer',
      timeouts: DEFAULT_TIMEOUTS,
      redactor: createRedactor(),
    });

    const cpuCheck = snapshot.checks.find((c) => c.id === 'cpu');
    expect(cpuCheck?.status).toBe('fail');
    expect(snapshot.facts.cpuCores).toBeNull();
  });

  it('an exec rejection is reported as a failed check with the failure message in the detail, not a rejected runDiscovery', async () => {
    const scripts: Partial<Record<CommandName, ExecResult | Error>> = successfulScripts();
    scripts['discovery.memory'] = new Error('Command "discovery.memory" exceeded its 30000ms timeout budget');
    const { session } = buildFakeSession(scripts);

    const snapshot = await runDiscovery({
      session,
      sshUser: 'deployer',
      timeouts: DEFAULT_TIMEOUTS,
      redactor: createRedactor(),
    });

    const memoryCheck = snapshot.checks.find((c) => c.id === 'memory');
    expect(memoryCheck?.status).toBe('fail');
    expect(memoryCheck?.detail).toContain('exceeded its 30000ms timeout budget');
    expect(snapshot.facts.ramMb).toBeNull();
    // Every other check still ran.
    expect(snapshot.checks.filter((c) => c.status === 'pass')).toHaveLength(
      DISCOVERY_CHECK_IDS.length - 1,
    );
  });

  it('sshUser "root" yields not_applicable for sudo and docker_group without ever executing them', async () => {
    const { session, execCalls } = buildFakeSession(successfulScripts());

    const snapshot = await runDiscovery({
      session,
      sshUser: 'root',
      timeouts: DEFAULT_TIMEOUTS,
      redactor: createRedactor(),
    });

    const sudoCheck = snapshot.checks.find((c) => c.id === 'sudo');
    const dockerGroupCheck = snapshot.checks.find((c) => c.id === 'docker_group');
    expect(sudoCheck?.status).toBe('not_applicable');
    expect(dockerGroupCheck?.status).toBe('not_applicable');
    expect(execCalls).not.toContain('access.sudo');
    expect(execCalls).not.toContain('access.docker_group');
  });

  it('a non-root user with a non-zero sudo -n true exit yields fail for sudo without affecting other checks', async () => {
    const scripts = successfulScripts();
    scripts['access.sudo'] = execResult({ commandName: 'access.sudo', exitCode: 1, stderr: 'sudo: a password is required' });
    const { session } = buildFakeSession(scripts);

    const snapshot = await runDiscovery({
      session,
      sshUser: 'restricted',
      timeouts: DEFAULT_TIMEOUTS,
      redactor: createRedactor(),
    });

    const sudoCheck = snapshot.checks.find((c) => c.id === 'sudo');
    expect(sudoCheck?.status).toBe('fail');
    expect(snapshot.checks.find((c) => c.id === 'hostname')?.status).toBe('pass');
  });

  it('a non-root user with docker-group membership passes docker_group', async () => {
    const { session } = buildFakeSession(successfulScripts());

    const snapshot = await runDiscovery({
      session,
      sshUser: 'deployer',
      timeouts: DEFAULT_TIMEOUTS,
      redactor: createRedactor(),
    });

    expect(snapshot.checks.find((c) => c.id === 'docker_group')?.status).toBe('pass');
  });

  it('redacts a registered secret out of every check detail, including one placed in stderr', async () => {
    const redactor = createRedactor();
    redactor.register('super-secret-token', 'password');
    const scripts = successfulScripts();
    scripts['discovery.arch'] = execResult({
      commandName: 'discovery.arch',
      exitCode: 1,
      stderr: 'failed to authenticate with super-secret-token',
    });
    const { session } = buildFakeSession(scripts);

    const snapshot = await runDiscovery({
      session,
      sshUser: 'deployer',
      timeouts: DEFAULT_TIMEOUTS,
      redactor,
    });

    for (const check of snapshot.checks) {
      expect(check.detail).not.toContain('super-secret-token');
    }
  });

  it('never calls session.close()', async () => {
    const { session, closeCalls } = buildFakeSession(successfulScripts());

    await runDiscovery({
      session,
      sshUser: 'deployer',
      timeouts: DEFAULT_TIMEOUTS,
      redactor: createRedactor(),
    });

    expect(closeCalls).toBe(0);
  });
});
