import { describe, expect, it } from 'vitest';
import { DEPLOYMENT_STATUSES } from './deployment-state.js';
import { decideStaleQueued, staleQueuedCutoff, type StaleQueuedJob } from './stale-queued.js';

const NOW = new Date('2026-10-07T12:00:00.000Z');
const THRESHOLD = 120_000;
const old = new Date(NOW.getTime() - THRESHOLD - 1);

describe('staleQueuedCutoff', () => {
  it('is now minus the threshold', () => {
    expect(staleQueuedCutoff(NOW, THRESHOLD).toISOString()).toBe('2026-10-07T11:58:00.000Z');
  });
});

describe('decideStaleQueued (14-08)', () => {
  it('fails a QUEUED row older than the threshold whose job is absent', () => {
    expect(decideStaleQueued({ status: 'QUEUED', createdAt: old, now: NOW, thresholdMs: THRESHOLD, job: 'absent' })).toBe('fail');
  });

  it('never fails a row whose job is live (A2)', () => {
    expect(decideStaleQueued({ status: 'QUEUED', createdAt: old, now: NOW, thresholdMs: THRESHOLD, job: 'live' })).toBe('skip');
  });

  it('treats an unknown job lookup (Redis error) as skip, never as absent (H2)', () => {
    expect(decideStaleQueued({ status: 'QUEUED', createdAt: old, now: NOW, thresholdMs: THRESHOLD, job: 'unknown' })).toBe('skip');
  });

  it('never fails a row younger than or exactly at the threshold (A2)', () => {
    const atThreshold = new Date(NOW.getTime() - THRESHOLD);
    const young = new Date(NOW.getTime() - 1_000);
    for (const createdAt of [atThreshold, young, NOW]) {
      expect(decideStaleQueued({ status: 'QUEUED', createdAt, now: NOW, thresholdMs: THRESHOLD, job: 'absent' })).toBe('skip');
    }
  });

  it('skips a createdAt in the future (clock skew) or an invalid date', () => {
    const future = new Date(NOW.getTime() + 60_000);
    for (const createdAt of [future, new Date(Number.NaN)]) {
      expect(decideStaleQueued({ status: 'QUEUED', createdAt, now: NOW, thresholdMs: THRESHOLD, job: 'absent' })).toBe('skip');
    }
  });

  it('never touches a row that is no longer QUEUED', () => {
    const jobs: readonly StaleQueuedJob[] = ['absent', 'live', 'unknown'];
    for (const status of DEPLOYMENT_STATUSES.filter((s) => s !== 'QUEUED')) {
      for (const job of jobs) {
        expect(decideStaleQueued({ status, createdAt: old, now: NOW, thresholdMs: THRESHOLD, job })).toBe('skip');
      }
    }
  });

  it('skips when the threshold is not a positive finite number', () => {
    for (const thresholdMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(decideStaleQueued({ status: 'QUEUED', createdAt: old, now: NOW, thresholdMs, job: 'absent' })).toBe('skip');
    }
  });
});
