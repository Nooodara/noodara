// RED-first for Task 2: every rendering decision about discovery progress is a tested pure
// function that structurally cannot invent progress (D-05, 05-RESEARCH.md Pitfall 3, SS4.2/SS4.3).
import { describe, expect, it } from 'vitest';
import { DISCOVERY_CHECK_IDS, type DiscoveryCheck } from '@noodara/domain/discovery';
import {
  buildChecklist,
  severityFor,
  summarize,
  type DiscoverySettledSnapshot,
} from './discovery-progress';

function check(id: (typeof DISCOVERY_CHECK_IDS)[number], overrides: Partial<DiscoveryCheck> = {}): DiscoveryCheck {
  return { id, status: 'pass', detail: `${id} ok`, durationMs: 12, ...overrides };
}

const EMPTY_SETTLED: DiscoverySettledSnapshot = { collectedAt: null, checks: [], warnings: [] };

function fullSettled(overrides: Partial<Record<(typeof DISCOVERY_CHECK_IDS)[number], DiscoveryCheck>> = {}): DiscoverySettledSnapshot {
  return {
    collectedAt: '2026-09-19T12:00:00.000Z',
    checks: DISCOVERY_CHECK_IDS.map((id) => overrides[id] ?? check(id)),
    warnings: [],
  };
}

describe('severityFor', () => {
  it('is warning for a fail on docker_version, docker_compose_version, sudo or docker_group', () => {
    for (const id of ['docker_version', 'docker_compose_version', 'sudo', 'docker_group'] as const) {
      expect(severityFor(check(id, { status: 'fail' }), [])).toBe('warning');
    }
  });

  it('is fail for a fail on any of the other seven ids', () => {
    for (const id of ['hostname', 'os_release', 'arch', 'cpu', 'memory', 'disk', 'uptime'] as const) {
      expect(severityFor(check(id, { status: 'fail' }), [])).toBe('fail');
    }
  });

  it('is skipped/not_applicable for a skipped/not_applicable check, regardless of id', () => {
    expect(severityFor(check('docker_compose_version', { status: 'skipped' }), [])).toBe('skipped');
    expect(severityFor(check('sudo', { status: 'not_applicable' }), [])).toBe('not_applicable');
  });

  it('is warning for a pass on os_release when the run warnings include UNSUPPORTED_OS', () => {
    expect(severityFor(check('os_release', { status: 'pass' }), ['UNSUPPORTED_OS'])).toBe('warning');
  });

  it('is pass for a pass on os_release with no UNSUPPORTED_OS warning, and pass for any other passing id', () => {
    expect(severityFor(check('os_release', { status: 'pass' }), [])).toBe('pass');
    expect(severityFor(check('cpu', { status: 'pass' }), ['UNSUPPORTED_OS'])).toBe('pass');
  });
});

describe('buildChecklist -- live (CONNECTING)', () => {
  it('renders both connection steps running and all four discovery steps pending with zero received checks', () => {
    const checklist = buildChecklist({ serverStatus: 'CONNECTING', receivedChecks: [], settled: EMPTY_SETTLED });

    const byId = Object.fromEntries(checklist.steps.map((s) => [s.id, s]));
    expect(byId.ssh_reachable?.state).toBe('running');
    expect(byId.authenticated?.state).toBe('running');
    for (const stepId of ['os', 'resources', 'docker', 'access'] as const) {
      expect(byId[stepId]?.state).toBe('pending');
      for (const c of byId[stepId]?.checks ?? []) {
        expect(c.state).toBe('pending');
        expect(c.detail).toBeNull();
      }
    }
  });

  it('discards a fully populated settled checklist entirely while CONNECTING (D-05, Pitfall 3)', () => {
    const checklist = buildChecklist({
      serverStatus: 'CONNECTING',
      receivedChecks: [],
      settled: fullSettled(),
    });

    const resolvedDiscoverySteps = checklist.steps.filter(
      (s) => s.id !== 'ssh_reachable' && s.id !== 'authenticated' && s.state !== 'pending',
    );
    expect(resolvedDiscoverySteps).toHaveLength(0);
  });

  it('marks three received checks resolved, both connection steps passed, and the next id running with the rest pending', () => {
    const receivedChecks = [check('hostname'), check('os_release'), check('arch')];
    const checklist = buildChecklist({ serverStatus: 'CONNECTING', receivedChecks, settled: EMPTY_SETTLED });

    const byId = Object.fromEntries(checklist.steps.map((s) => [s.id, s]));
    expect(byId.ssh_reachable?.state).toBe('pass');
    expect(byId.authenticated?.state).toBe('pass');

    const osChecks = byId.os?.checks ?? [];
    expect(osChecks.map((c) => c.state)).toEqual(['pass', 'pass', 'pass']);

    const resourcesChecks = byId.resources?.checks ?? [];
    // cpu is the next id in DISCOVERY_CHECK_IDS order after hostname/os_release/arch.
    expect(resourcesChecks[0]?.id).toBe('cpu');
    expect(resourcesChecks[0]?.state).toBe('running');
    expect(resourcesChecks.slice(1).every((c) => c.state === 'pending')).toBe(true);

    expect(byId.docker?.checks.every((c) => c.state === 'pending')).toBe(true);
    expect(byId.access?.checks.every((c) => c.state === 'pending')).toBe(true);
  });
});

describe('buildChecklist -- mid-run mount (05-VERIFICATION.md gap 3 / SC3, D-05)', () => {
  it('renders every unreceived earlier id as pending -- never running, never pass -- when only late ids were received', () => {
    // A page that joined mid-run and only ever saw the two Docker-group checks (late in
    // DISCOVERY_CHECK_IDS order): every earlier id (hostname..sudo/docker_group's siblings) must
    // never be inferred as resolved just because a later one already came in.
    const receivedChecks = [check('docker_version'), check('docker_compose_version')];
    const checklist = buildChecklist({ serverStatus: 'CONNECTING', receivedChecks, settled: EMPTY_SETTLED });
    const byId = Object.fromEntries(checklist.steps.map((s) => [s.id, s]));

    for (const stepId of ['os', 'resources'] as const) {
      expect(byId[stepId]?.state).toBe('pending');
      for (const c of byId[stepId]?.checks ?? []) {
        expect(c.state).toBe('pending');
      }
    }
  });

  it('excludes an unreceived earlier check from its step aggregation, so the step never reports pass on the strength of a later check alone', () => {
    // 'resources' groups cpu/memory/disk/uptime (D-06). Only uptime (the last of the four) was
    // received and passed -- cpu/memory/disk were never observed by this page. SS4.2's seven-word
    // vocabulary has no "pass, but incomplete" word, so the step must report the conservative,
    // already-defined 'pending' rather than inventing a pass it cannot back up with cpu/memory/disk.
    const receivedChecks = [check('uptime')];
    const checklist = buildChecklist({ serverStatus: 'CONNECTING', receivedChecks, settled: EMPTY_SETTLED });
    const resources = checklist.steps.find((s) => s.id === 'resources');

    expect(resources?.state).toBe('pending');
    expect(resources?.state).not.toBe('pass');
    const byCheckId = Object.fromEntries((resources?.checks ?? []).map((c) => [c.id, c.state]));
    expect(byCheckId.cpu).toBe('pending');
    expect(byCheckId.memory).toBe('pending');
    expect(byCheckId.disk).toBe('pending');
    expect(byCheckId.uptime).toBe('pass');
  });

  it('marks exactly one id running -- the one immediately after the last received id in DISCOVERY_CHECK_IDS order', () => {
    const receivedChecks = [check('hostname'), check('os_release')];
    const checklist = buildChecklist({ serverStatus: 'CONNECTING', receivedChecks, settled: EMPTY_SETTLED });

    const allChecks = checklist.steps.flatMap((s) => s.checks);
    const running = allChecks.filter((c) => c.state === 'running');
    expect(running).toHaveLength(1);
    expect(running[0]?.id).toBe('arch'); // the id right after os_release (the last received one)
  });

  it('marks no discovery id running before any check has been received', () => {
    const checklist = buildChecklist({ serverStatus: 'CONNECTING', receivedChecks: [], settled: EMPTY_SETTLED });
    const allChecks = checklist.steps.flatMap((s) => s.checks);
    expect(allChecks.some((c) => c.state === 'running')).toBe(false);
  });

  it('still resolves both connection steps to pass from a received check even when only late ids were received (D-05 derivation, pinned)', () => {
    const receivedChecks = [check('sudo')];
    const checklist = buildChecklist({ serverStatus: 'CONNECTING', receivedChecks, settled: EMPTY_SETTLED });
    const byId = Object.fromEntries(checklist.steps.map((s) => [s.id, s]));

    expect(byId.ssh_reachable?.state).toBe('pass');
    expect(byId.authenticated?.state).toBe('pass');
  });
});

describe('buildChecklist -- settled', () => {
  it('marks every step from a complete settled checklist and marks no step running', () => {
    const checklist = buildChecklist({ serverStatus: 'CONNECTED', receivedChecks: [], settled: fullSettled() });

    expect(checklist.steps.some((s) => s.state === 'running')).toBe(false);
    const byId = Object.fromEntries(checklist.steps.map((s) => [s.id, s]));
    expect(byId.ssh_reachable?.state).toBe('pass');
    expect(byId.authenticated?.state).toBe('pass');
    for (const stepId of ['os', 'resources', 'docker', 'access'] as const) {
      expect(byId[stepId]?.state).toBe('pass');
    }
  });

  it('a step passes only if every check passes; fails if any check truly fails', () => {
    const settled = fullSettled({ hostname: check('hostname', { status: 'fail' }) });
    const checklist = buildChecklist({ serverStatus: 'ERROR', receivedChecks: [], settled });
    const os = checklist.steps.find((s) => s.id === 'os');
    expect(os?.state).toBe('fail');
  });

  it('a step is warning when a usable-despite-failure check fails, even if its sibling check passes', () => {
    const settled = fullSettled({ docker_version: check('docker_version', { status: 'fail' }) });
    const checklist = buildChecklist({ serverStatus: 'CONNECTED', receivedChecks: [], settled });
    const docker = checklist.steps.find((s) => s.id === 'docker');
    expect(docker?.state).toBe('warning');
  });

  it('a step is not_applicable when every one of its checks is not_applicable (root connection, Access)', () => {
    const settled = fullSettled({
      sudo: check('sudo', { status: 'not_applicable' }),
      docker_group: check('docker_group', { status: 'not_applicable' }),
    });
    const checklist = buildChecklist({ serverStatus: 'CONNECTED', receivedChecks: [], settled });
    const access = checklist.steps.find((s) => s.id === 'access');
    expect(access?.state).toBe('not_applicable');
  });
});

describe('summarize', () => {
  it('counts steps, excluding fully-idle steps from the denominator, naming warnings/failures only when non-zero', () => {
    const settled = fullSettled({
      sudo: check('sudo', { status: 'not_applicable' }),
      docker_group: check('docker_group', { status: 'not_applicable' }),
    });
    const checklist = buildChecklist({ serverStatus: 'CONNECTED', receivedChecks: [], settled });

    // access (not_applicable) is excluded from the denominator -- 5 applicable steps, all passing.
    expect(summarize(checklist)).toBe('5 of 5 passed');
  });

  it('names a singular warning and a plural failure count', () => {
    const settled = fullSettled({
      docker_version: check('docker_version', { status: 'fail' }),
      hostname: check('hostname', { status: 'fail' }),
      arch: check('arch', { status: 'fail' }),
    });
    const checklist = buildChecklist({ serverStatus: 'ERROR', receivedChecks: [], settled });

    // os (fail, from hostname+arch) and docker (warning, from docker_version) both count.
    expect(summarize(checklist)).toContain('warning');
    expect(summarize(checklist)).toContain('failed');
    expect(summarize(checklist)).not.toContain('1 warnings');
  });
});
