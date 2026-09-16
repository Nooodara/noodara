import { describe, expect, it } from 'vitest';
import { DISCOVERY_CHECK_IDS, type DiscoveryCheckStatus, type DiscoveryFacts } from './types.js';
import { classifySnapshotOutcome, mergeDiscoveryFacts } from './merge-facts.js';

function buildFacts(overrides: Partial<DiscoveryFacts> = {}): DiscoveryFacts {
  return {
    hostname: null,
    osDistribution: null,
    osVersion: null,
    arch: null,
    cpuCores: null,
    ramMb: null,
    diskTotalMb: null,
    diskUsedMb: null,
    uptimeSeconds: null,
    dockerInstalled: null,
    dockerVersion: null,
    dockerComposeVersion: null,
    ...overrides,
  };
}

function buildCheck(overrides: Partial<{ status: DiscoveryCheckStatus }> = {}) {
  return {
    id: DISCOVERY_CHECK_IDS[0],
    status: 'pass' as DiscoveryCheckStatus,
    detail: '',
    durationMs: 0,
    ...overrides,
  };
}

const FACTS_KEYS = [
  'hostname',
  'osDistribution',
  'osVersion',
  'arch',
  'cpuCores',
  'ramMb',
  'diskTotalMb',
  'diskUsedMb',
  'uptimeSeconds',
  'dockerInstalled',
  'dockerVersion',
  'dockerComposeVersion',
] as const satisfies readonly (keyof DiscoveryFacts)[];

// Non-null sample value per key, distinct from any other key's sample, used by the exhaustive
// null-never-overwrites table below.
const SAMPLE_VALUES: { [K in (typeof FACTS_KEYS)[number]]: DiscoveryFacts[K] } = {
  hostname: 'web-1',
  osDistribution: 'Ubuntu',
  osVersion: '24.04',
  arch: 'x86_64',
  cpuCores: 8,
  ramMb: 16384,
  diskTotalMb: 512000,
  diskUsedMb: 128000,
  uptimeSeconds: 3600,
  dockerInstalled: true,
  dockerVersion: '27.0.0',
  dockerComposeVersion: '2.29.0',
};

describe('mergeDiscoveryFacts', () => {
  it('every non-null field of incoming wins over current', () => {
    const current = buildFacts({ hostname: 'old-host', cpuCores: 4 });
    const incoming = buildFacts({ hostname: 'new-host', cpuCores: 8 });

    const merged = mergeDiscoveryFacts(current, incoming);

    expect(merged.hostname).toBe('new-host');
    expect(merged.cpuCores).toBe(8);
  });

  it('every null field of incoming leaves a non-null current value untouched (D-07)', () => {
    const current = buildFacts({ hostname: 'kept-host', cpuCores: 4 });
    const incoming = buildFacts({ hostname: null, cpuCores: null });

    const merged = mergeDiscoveryFacts(current, incoming);

    expect(merged.hostname).toBe('kept-host');
    expect(merged.cpuCores).toBe(4);
  });

  it('dockerInstalled: false overwrites true (false is a value, not an absence)', () => {
    const current = buildFacts({ dockerInstalled: true });
    const incoming = buildFacts({ dockerInstalled: false });

    const merged = mergeDiscoveryFacts(current, incoming);

    expect(merged.dockerInstalled).toBe(false);
  });

  it('cpuCores: 0 overwrites 8 (0 is a value, not an absence)', () => {
    const current = buildFacts({ cpuCores: 8 });
    const incoming = buildFacts({ cpuCores: 0 });

    const merged = mergeDiscoveryFacts(current, incoming);

    expect(merged.cpuCores).toBe(0);
  });

  it('never mutates current', () => {
    const current = buildFacts({ hostname: 'stable-host', cpuCores: 4 });
    const pristine = { ...current };

    mergeDiscoveryFacts(current, buildFacts({ hostname: 'other-host' }));

    expect(current).toEqual(pristine);
  });

  it('an all-null incoming returns a value deep-equal to current', () => {
    const current = buildFacts({ hostname: 'stable-host', cpuCores: 4, dockerInstalled: true });

    const merged = mergeDiscoveryFacts(current, buildFacts());

    expect(merged).toEqual(current);
  });

  it('an all-null current (freshly registered server) returns exactly incoming non-null values', () => {
    const incoming = buildFacts({ hostname: 'fresh-host', cpuCores: 2 });

    const merged = mergeDiscoveryFacts(buildFacts(), incoming);

    expect(merged).toEqual(incoming);
  });

  it('the result has exactly the 12 DiscoveryFacts keys, no more', () => {
    const merged = mergeDiscoveryFacts(buildFacts(), buildFacts());

    expect(Object.keys(merged).sort()).toEqual([...FACTS_KEYS].sort());
  });

  describe('null-never-overwrites, exhaustive per key (D-07)', () => {
    it.each(FACTS_KEYS)('%s: a null incoming value leaves the current value untouched', (key) => {
      const current = buildFacts({ [key]: SAMPLE_VALUES[key] });
      const incoming = buildFacts({ [key]: null });

      const merged = mergeDiscoveryFacts(current, incoming);

      expect(merged[key]).toEqual(SAMPLE_VALUES[key]);
    });

    it.each(FACTS_KEYS)('%s: a non-null incoming value overwrites the current value', (key) => {
      const current = buildFacts();
      const incoming = buildFacts({ [key]: SAMPLE_VALUES[key] });

      const merged = mergeDiscoveryFacts(current, incoming);

      expect(merged[key]).toEqual(SAMPLE_VALUES[key]);
    });
  });
});

describe('classifySnapshotOutcome', () => {
  it('an empty checks array is failed (nothing ran)', () => {
    expect(classifySnapshotOutcome([])).toBe('failed');
  });

  it('only skipped/not_applicable entries is failed', () => {
    expect(
      classifySnapshotOutcome([buildCheck({ status: 'skipped' }), buildCheck({ status: 'not_applicable' })]),
    ).toBe('failed');
  });

  it('every relevant check pass is ok', () => {
    expect(
      classifySnapshotOutcome([buildCheck({ status: 'pass' }), buildCheck({ status: 'pass' })]),
    ).toBe('ok');
  });

  it('every relevant check fail is failed', () => {
    expect(
      classifySnapshotOutcome([buildCheck({ status: 'fail' }), buildCheck({ status: 'fail' })]),
    ).toBe('failed');
  });

  it('a mix of pass and fail is partial', () => {
    expect(
      classifySnapshotOutcome([buildCheck({ status: 'pass' }), buildCheck({ status: 'fail' })]),
    ).toBe('partial');
  });

  it('skipped/not_applicable entries are excluded and never change an otherwise-ok answer', () => {
    expect(
      classifySnapshotOutcome([
        buildCheck({ status: 'pass' }),
        buildCheck({ status: 'skipped' }),
        buildCheck({ status: 'not_applicable' }),
      ]),
    ).toBe('ok');
  });

  it('skipped/not_applicable entries are excluded and never change an otherwise-failed answer', () => {
    expect(
      classifySnapshotOutcome([
        buildCheck({ status: 'fail' }),
        buildCheck({ status: 'skipped' }),
        buildCheck({ status: 'not_applicable' }),
      ]),
    ).toBe('failed');
  });

  it('skipped/not_applicable entries are excluded and never change an otherwise-partial answer', () => {
    expect(
      classifySnapshotOutcome([
        buildCheck({ status: 'pass' }),
        buildCheck({ status: 'fail' }),
        buildCheck({ status: 'skipped' }),
        buildCheck({ status: 'not_applicable' }),
      ]),
    ).toBe('partial');
  });
});
