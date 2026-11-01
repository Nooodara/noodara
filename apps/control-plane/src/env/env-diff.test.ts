import { describe, expect, it } from 'vitest';
import type { RuntimeEnvEntry } from '@noodara/domain';
import { differsFromRunning, NO_RUNNING_DEPLOYMENT } from './env-diff.js';

const HC = { type: 'container', probeTimeoutS: 5, intervalS: 1, retries: 5, startPeriodS: 0 };

const snapshot = (env: readonly RuntimeEnvEntry[]) => ({
  version: 2,
  imageRef: 'nginx:1.27',
  internalPort: 80,
  publishedPort: null,
  healthcheck: HC,
  env,
});

const PLAIN_A: RuntimeEnvEntry = { key: 'A', value: '1' };
const REF_DB: RuntimeEnvEntry = { key: 'DB', secretRef: 'db_password', secretVersion: 2 };
const running: RuntimeEnvEntry[] = [PLAIN_A, REF_DB];

describe('differsFromRunning (23-02 A3)', () => {
  it('is false when nothing has run yet', () => {
    expect(differsFromRunning(running, NO_RUNNING_DEPLOYMENT)).toBe(false);
  });

  it('is false for the same keys, plain values, reference names and versions in any order', () => {
    expect(differsFromRunning([...running].reverse(), snapshot(running))).toBe(false);
  });

  it.each<[string, RuntimeEnvEntry[]]>([
    ['a changed plain value', [{ key: 'A', value: '2' }, REF_DB]],
    ['a new key', [...running, { key: 'B', value: '1' }]],
    ['a removed key', [PLAIN_A]],
    ['a renamed reference', [PLAIN_A, { key: 'DB', secretRef: 'db_pass', secretVersion: 2 }]],
    ['a rotated secret', [PLAIN_A, { key: 'DB', secretRef: 'db_password', secretVersion: 3 }]],
    ['plain to reference', [{ key: 'A', secretRef: 'a', secretVersion: 1 }, REF_DB]],
  ])('is true for %s', (_label, current) => {
    expect(differsFromRunning(current, snapshot(running))).toBe(true);
  });

  it('is true when a current reference does not resolve', () => {
    expect(differsFromRunning(null, snapshot(running))).toBe(true);
  });

  it('is true for an unparseable snapshot', () => {
    expect(differsFromRunning(running, { version: 9 })).toBe(true);
  });

  it('treats a v1 snapshot or a missing runtime config as an empty env', () => {
    const v1 = { version: 1, imageRef: 'nginx:1.27', internalPort: 80, publishedPort: null, healthcheck: HC };
    expect(differsFromRunning([], v1)).toBe(false);
    expect(differsFromRunning([], null)).toBe(false);
    expect(differsFromRunning(running, null)).toBe(true);
  });
});
