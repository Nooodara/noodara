// RED-first for Task 1: the six-step grouping cannot silently lose or misplace a check id. The
// completeness assertion iterates `DISCOVERY_CHECK_IDS` (imported from `@noodara/domain/discovery`
// directly, not a local copy), so it can never drift from the domain package either.
import { describe, expect, it } from 'vitest';
import { DISCOVERY_CHECK_IDS, type DiscoveryCheckId } from '@noodara/domain/discovery';
import {
  CHECK_TO_STEP,
  CONNECTION_STEP_NAMES,
  DISCOVERY_GROUP_STEPS,
  DISCOVERY_STEP_NAMES,
  STEP_LABELS,
  type DiscoveryStepName,
} from './discovery-steps';

describe('discovery-steps', () => {
  it('declares the six steps in D-06 fixed order', () => {
    expect(DISCOVERY_STEP_NAMES).toEqual(['ssh_reachable', 'authenticated', 'os', 'resources', 'docker', 'access']);
  });

  it('maps every one of the eleven DISCOVERY_CHECK_IDS to a step, iterating the imported tuple', () => {
    expect(DISCOVERY_CHECK_IDS.length).toBe(11);
    for (const id of DISCOVERY_CHECK_IDS) {
      const step = CHECK_TO_STEP[id];
      expect(step).toBeDefined();
      expect(DISCOVERY_STEP_NAMES).toContain(step);
    }
    // Exactly eleven entries -- no extra, no missing.
    expect(Object.keys(CHECK_TO_STEP)).toHaveLength(DISCOVERY_CHECK_IDS.length);
  });

  it('groups D-06 exact checks under OS/Resources/Docker/Access', () => {
    const grouped: Record<DiscoveryStepName, DiscoveryCheckId[]> = {
      ssh_reachable: [],
      authenticated: [],
      os: [],
      resources: [],
      docker: [],
      access: [],
    };
    for (const id of DISCOVERY_CHECK_IDS) {
      grouped[CHECK_TO_STEP[id]].push(id);
    }

    expect(grouped.os).toEqual(['hostname', 'os_release', 'arch']);
    expect(grouped.resources).toEqual(['cpu', 'memory', 'disk', 'uptime']);
    expect(grouped.docker).toEqual(['docker_version', 'docker_compose_version']);
    expect(grouped.access).toEqual(['sudo', 'docker_group']);
  });

  it('never maps a check to ssh_reachable or authenticated -- those two are connection-derived', () => {
    for (const id of DISCOVERY_CHECK_IDS) {
      expect(CHECK_TO_STEP[id]).not.toBe('ssh_reachable');
      expect(CHECK_TO_STEP[id]).not.toBe('authenticated');
    }
  });

  it('gives the exact SS4.1 human label for every step', () => {
    expect(STEP_LABELS).toEqual({
      ssh_reachable: 'SSH reachable',
      authenticated: 'Authenticated',
      os: 'OS',
      resources: 'Resources',
      docker: 'Docker',
      access: 'Access',
    });
  });

  it('exposes the discovery-group/connection-step split used by discovery-progress.ts', () => {
    expect(DISCOVERY_GROUP_STEPS).toEqual(['os', 'resources', 'docker', 'access']);
    expect(CONNECTION_STEP_NAMES).toEqual(['ssh_reachable', 'authenticated']);
  });
});
