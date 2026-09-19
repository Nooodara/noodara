// Task 1 (DISC-01, SERV-08, D-13): the branch matrix for one discovery run over a single session.
// Driven entirely against a fake `SshSession` whose `exec` returns scripted `ExecResult`s (and
// rejections) per command name — the real-container proof of the whole flow is plan 02-10's
// `discovery.test.ts`. This file's job is the pass/fail/parser-failure/timeout/root/non-root
// branch matrix, which needs dozens of scripted permutations that would cost a container start
// each otherwise.
import { createRedactor, secretValue } from '@noodara/domain/security';
import { DISCOVERY_CHECK_IDS, type DiscoveryCheck } from '@noodara/domain/discovery';
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

// Builds a `now` stub that returns each value in `values` once, in order, and throws if called
// more times than the test expected — every scenario below scripts the exact number of `now()`
// calls `runDiscovery`'s loop is expected to make, so an unexpected extra call is itself a bug.
function scriptedClock(values: readonly number[]): () => number {
  let index = 0;
  return () => {
    const value = values[index];
    index += 1;
    if (value === undefined) {
      throw new Error(`now() was called more times (${String(index)}) than this test scripted`);
    }
    return value;
  };
}

describe('runDiscovery — warnings and the D-08 discovery-total budget (DISC-04, D-08, D-11, D-12)', () => {
  it('an unsupported OS adds UNSUPPORTED_OS to warnings, keeps os_release passing, and leaves every other fact intact', async () => {
    const scripts = successfulScripts();
    scripts['discovery.os_release'] = execResult({
      commandName: 'discovery.os_release',
      stdout: 'ID=debian\nNAME="Debian"\nVERSION_ID="12"\n',
    });
    const { session } = buildFakeSession(scripts);

    const snapshot = await runDiscovery({
      session,
      sshUser: 'deployer',
      timeouts: DEFAULT_TIMEOUTS,
      redactor: createRedactor(),
    });

    expect(snapshot.warnings).toContain('UNSUPPORTED_OS');
    expect(snapshot.checks.find((c) => c.id === 'os_release')?.status).toBe('pass');
    expect(snapshot.facts.hostname).toBe('web-01');
    expect(snapshot.facts.cpuCores).toBe(4);
    expect(snapshot.facts.dockerInstalled).toBe(true);
  });

  it('a not_installed docker_version sets dockerInstalled false, dockerVersion null, and skips docker_compose_version', async () => {
    const scripts = successfulScripts();
    scripts['docker.version'] = execResult({ commandName: 'docker.version', exitCode: 127, stdout: '' });
    const { session, execCalls } = buildFakeSession(scripts);

    const snapshot = await runDiscovery({
      session,
      sshUser: 'deployer',
      timeouts: DEFAULT_TIMEOUTS,
      redactor: createRedactor(),
    });

    expect(snapshot.facts.dockerInstalled).toBe(false);
    expect(snapshot.facts.dockerVersion).toBeNull();
    expect(snapshot.checks.find((c) => c.id === 'docker_version')?.status).toBe('fail');
    expect(snapshot.checks.find((c) => c.id === 'docker_compose_version')?.status).toBe('skipped');
    expect(execCalls).not.toContain('docker.compose_version');
  });

  it('an unparseable docker_version leaves dockerInstalled null, explicitly never false', async () => {
    const scripts = successfulScripts();
    scripts['docker.version'] = execResult({ commandName: 'docker.version', stdout: 'not json at all', exitCode: 0 });
    const { session } = buildFakeSession(scripts);

    const snapshot = await runDiscovery({
      session,
      sshUser: 'deployer',
      timeouts: DEFAULT_TIMEOUTS,
      redactor: createRedactor(),
    });

    expect(snapshot.facts.dockerInstalled).toBeNull();
    expect(snapshot.facts.dockerInstalled).not.toBe(false);
    expect(snapshot.checks.find((c) => c.id === 'docker_version')?.status).toBe('fail');
    // docker_compose_version is not skipped for an unparseable result — only a measured
    // not_installed does that (D-12, Pitfall 2).
    expect(snapshot.checks.find((c) => c.id === 'docker_compose_version')?.status).not.toBe('skipped');
  });

  it('a daemon_unreachable docker_version keeps dockerInstalled true with the client version', async () => {
    const scripts = successfulScripts();
    scripts['docker.version'] = execResult({
      commandName: 'docker.version',
      stdout: '{"Client":{"Version":"24.0.7"},"Server":null}',
      exitCode: 1,
    });
    const { session } = buildFakeSession(scripts);

    const snapshot = await runDiscovery({
      session,
      sshUser: 'deployer',
      timeouts: DEFAULT_TIMEOUTS,
      redactor: createRedactor(),
    });

    expect(snapshot.facts.dockerInstalled).toBe(true);
    expect(snapshot.facts.dockerVersion).toBe('24.0.7');
  });

  it('aborts the run once the injected clock exceeds the discovery-total budget, keeping what was already collected', async () => {
    const { session } = buildFakeSession(successfulScripts());
    // call 1: startedAt. calls 2-4: hostname/os_release/arch stay under the 100ms budget.
    // call 5: cpu's own top-of-loop check is over budget — cpu becomes the aborted check and
    // every entry after it is skipped without any further now() call.
    const now = scriptedClock([0, 10, 50, 90, 150]);

    const snapshot = await runDiscovery({
      session,
      sshUser: 'deployer',
      timeouts: { discoveryMs: 100 },
      redactor: createRedactor(),
      now,
    });

    expect(snapshot.facts.hostname).toBe('web-01');
    expect(snapshot.facts.osDistribution).toBe('Ubuntu');
    expect(snapshot.facts.arch).toBe('x86_64');
    expect(snapshot.facts.cpuCores).toBeNull();

    const cpuCheck = snapshot.checks.find((c) => c.id === 'cpu');
    expect(cpuCheck?.status).not.toBe('pass');
    expect(cpuCheck?.detail.toLowerCase()).toContain('budget');

    const stillPendingIds = [
      'memory',
      'disk',
      'uptime',
      'docker_version',
      'docker_compose_version',
      'sudo',
      'docker_group',
    ];
    for (const id of stillPendingIds) {
      expect(snapshot.checks.find((c) => c.id === id)?.status).toBe('skipped');
    }

    expect(snapshot.warnings).toContain('COMMAND_TIMEOUT');
  });

  it('warnings contains no duplicates across a run that triggers two distinct warning sources', async () => {
    const scripts = successfulScripts();
    scripts['discovery.os_release'] = execResult({
      commandName: 'discovery.os_release',
      stdout: 'ID=debian\nNAME="Debian"\nVERSION_ID="12"\n',
    });
    const { session } = buildFakeSession(scripts);
    // call 1: startedAt. calls 2-4: hostname/os_release (triggers UNSUPPORTED_OS)/arch pass.
    // call 5: cpu trips the 100ms budget (triggers COMMAND_TIMEOUT).
    const now = scriptedClock([0, 5, 10, 20, 200]);

    const snapshot = await runDiscovery({
      session,
      sshUser: 'deployer',
      timeouts: { discoveryMs: 100 },
      redactor: createRedactor(),
      now,
    });

    expect(snapshot.warnings).toContain('UNSUPPORTED_OS');
    expect(snapshot.warnings).toContain('COMMAND_TIMEOUT');
    expect(new Set(snapshot.warnings).size).toBe(snapshot.warnings.length);
  });
});

describe('runDiscovery — onCheck callback (D-05)', () => {
  it('invokes onCheck once per check, in DISCOVERY_SEQUENCE order, deeply equal to the returned snapshot', async () => {
    const { session } = buildFakeSession(successfulScripts());
    const received: DiscoveryCheck[] = [];

    const snapshot = await runDiscovery({
      session,
      sshUser: 'deployer',
      timeouts: DEFAULT_TIMEOUTS,
      redactor: createRedactor(),
      onCheck: (check) => {
        received.push(check);
      },
    });

    expect(received).toHaveLength(DISCOVERY_CHECK_IDS.length);
    expect(received.map((c) => c.id)).toEqual(DISCOVERY_SEQUENCE.map((e) => e.id));
    expect(received).toEqual(snapshot.checks);
  });

  it('still invokes onCheck for docker_compose_version (skipped) when docker_version is not installed', async () => {
    const scripts = successfulScripts();
    scripts['docker.version'] = execResult({ commandName: 'docker.version', exitCode: 127, stdout: '' });
    const { session } = buildFakeSession(scripts);
    const received: DiscoveryCheck[] = [];

    await runDiscovery({
      session,
      sshUser: 'deployer',
      timeouts: DEFAULT_TIMEOUTS,
      redactor: createRedactor(),
      onCheck: (check) => {
        received.push(check);
      },
    });

    const composeCheck = received.find((c) => c.id === 'docker_compose_version');
    expect(composeCheck).toBeDefined();
    expect(composeCheck?.status).toBe('skipped');
  });

  it('invokes onCheck for the aborted check (fail) and every subsequent skipped check once the budget is exceeded', async () => {
    const { session } = buildFakeSession(successfulScripts());
    const now = scriptedClock([0, 10, 50, 90, 150]);
    const received: DiscoveryCheck[] = [];

    await runDiscovery({
      session,
      sshUser: 'deployer',
      timeouts: { discoveryMs: 100 },
      redactor: createRedactor(),
      now,
      onCheck: (check) => {
        received.push(check);
      },
    });

    const cpuCheck = received.find((c) => c.id === 'cpu');
    expect(cpuCheck?.status).toBe('fail');
    const stillPendingIds = [
      'memory',
      'disk',
      'uptime',
      'docker_version',
      'docker_compose_version',
      'sudo',
      'docker_group',
    ];
    for (const id of stillPendingIds) {
      expect(received.find((c) => c.id === id)?.status).toBe('skipped');
    }
    expect(received).toHaveLength(DISCOVERY_CHECK_IDS.length);
  });

  it('a throwing onCheck does not change the returned snapshot and does not reject runDiscovery', async () => {
    const { session: sessionA } = buildFakeSession(successfulScripts());
    const baseline = await runDiscovery({
      session: sessionA,
      sshUser: 'deployer',
      timeouts: DEFAULT_TIMEOUTS,
      redactor: createRedactor(),
    });

    const { session: sessionB } = buildFakeSession(successfulScripts());
    const snapshot = await runDiscovery({
      session: sessionB,
      sshUser: 'deployer',
      timeouts: DEFAULT_TIMEOUTS,
      redactor: createRedactor(),
      onCheck: () => {
        throw new Error('listener blew up');
      },
    });

    expect(snapshot).toEqual(baseline);
  });

  it('omitting onCheck entirely behaves exactly as before', async () => {
    const { session } = buildFakeSession(successfulScripts());

    const snapshot = await runDiscovery({
      session,
      sshUser: 'deployer',
      timeouts: DEFAULT_TIMEOUTS,
      redactor: createRedactor(),
    });

    expect(snapshot.checks).toHaveLength(DISCOVERY_CHECK_IDS.length);
  });
});

describe('@noodara/ssh public surface (T-2-42)', () => {
  // `commandFor` is included alongside the plan's own named list because
  // tests/integration/ssh/contracts.test.ts (plan 02-04, predating this plan) already reads it
  // from `@noodara/ssh` directly — the package's single `.` export entry is the only path that
  // file can reach it through, so removing it would break a standing, already-passing suite.
  const EXPECTED_RUNTIME_EXPORTS = [
    'COMMAND_NAMES',
    'InvalidCredentialError',
    'RETRYABLE_ERROR_CODES',
    'commandFor',
    'createSsh2Adapter',
    'formatFingerprint',
    'loadPrivateKey',
    'parseFingerprint',
    'runDiscovery',
  ] as const;

  it('exports exactly the deliberate public surface, no internal module leaking through', async () => {
    const publicSurface: Record<string, unknown> = await import('./index.js');

    expect(Object.keys(publicSurface).sort()).toEqual([...EXPECTED_RUNTIME_EXPORTS].sort());
  });
});

describe('public key-loader surface (D-15)', () => {
  it('loadPrivateKey imported from @noodara/ssh returns a validation failure for an unparseable key', async () => {
    const { loadPrivateKey } = await import('@noodara/ssh');
    const credential = {
      kind: 'private_key' as const,
      privateKey: secretValue('not-a-key', 'ssh_private_key'),
    };

    const result = loadPrivateKey(credential, createRedactor());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('validation');
    }
  });

  it('InvalidCredentialError imported from @noodara/ssh is a constructible Error subclass', async () => {
    const { InvalidCredentialError } = await import('@noodara/ssh');

    const error = new InvalidCredentialError('bad credential');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('InvalidCredentialError');
  });
});
