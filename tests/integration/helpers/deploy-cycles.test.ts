import { describe, expect, it } from 'vitest';
import {
  DF_FORMAT,
  dfRow,
  extraEntries,
  parseDf,
  parseDockerSize,
  reconcileLogChunks,
  reconcileWebhookDeliveries,
  replayDeploymentStatuses,
} from './deploy-cycles.js';

describe('replayDeploymentStatuses (20-02 A1)', () => {
  it('accepts a good deploy, an automatic rollback and a manual rollback path', () => {
    expect(
      replayDeploymentStatuses(['QUEUED', 'PREPARING', 'BUILDING', 'DEPLOYING', 'HEALTHCHECK', 'SUCCESS'], 'webhook'),
    ).toMatchObject({ ok: true, final: 'SUCCESS' });
    expect(
      replayDeploymentStatuses(
        ['QUEUED', 'PREPARING', 'BUILDING', 'DEPLOYING', 'HEALTHCHECK', 'ROLLING_BACK', 'ROLLED_BACK'],
        'manual',
      ),
    ).toMatchObject({ ok: true, final: 'ROLLED_BACK' });
    expect(
      replayDeploymentStatuses(['QUEUED', 'PREPARING', 'DEPLOYING', 'HEALTHCHECK', 'SUCCESS'], 'rollback'),
    ).toMatchObject({ ok: true, final: 'SUCCESS' });
  });

  it('treats a status announced twice in a row as one state', () => {
    const result = replayDeploymentStatuses(['QUEUED', 'QUEUED', 'PREPARING', 'FAILED', 'FAILED'], 'manual');
    expect(result).toEqual({ ok: true, final: 'FAILED', path: ['QUEUED', 'PREPARING', 'FAILED'] });
  });

  it('rejects a trigger-gated edge for another trigger, a skipped state, a non-QUEUED start and a non-terminal end', () => {
    expect(replayDeploymentStatuses(['QUEUED', 'PREPARING', 'DEPLOYING'], 'webhook')).toMatchObject({ ok: false });
    expect(replayDeploymentStatuses(['QUEUED', 'SUCCESS'], 'webhook')).toMatchObject({ ok: false });
    expect(replayDeploymentStatuses(['PREPARING', 'FAILED'], 'webhook')).toMatchObject({
      ok: false,
      reason: 'starts at PREPARING, not QUEUED',
    });
    expect(replayDeploymentStatuses([], 'webhook')).toMatchObject({ ok: false, reason: 'starts at nothing, not QUEUED' });
    expect(replayDeploymentStatuses(['QUEUED', 'PREPARING'], 'webhook')).toMatchObject({
      ok: false,
      reason: 'ends at PREPARING, not a terminal status',
    });
  });
});

describe('docker system df parsing (20-02 A2)', () => {
  it('parses decimal and binary sizes, and NaN for garbage', () => {
    expect(parseDockerSize('0B')).toBe(0);
    expect(parseDockerSize('12.5kB')).toBe(12_500);
    expect(parseDockerSize('1.2GB')).toBeCloseTo(1.2e9);
    expect(parseDockerSize('2MiB')).toBe(2 * 1024 * 1024);
    expect(parseDockerSize('n/a')).toBeNaN();
    expect(parseDockerSize('3XB')).toBeNaN();
  });

  it('reads every row of the delimited format, including types with spaces', () => {
    expect(DF_FORMAT).toContain('|');
    const rows = parseDf('Images|4|1|512MB\nContainers|1|1|0B\nLocal Volumes|0|0|0B\nBuild Cache|9|0|1.1GB\n');
    expect(rows).toHaveLength(4);
    expect(dfRow(rows, 'Local Volumes')).toEqual({ type: 'Local Volumes', total: 0, active: 0, sizeBytes: 0 });
    expect(dfRow(rows, 'Images').sizeBytes).toBe(512e6);
    expect(() => dfRow(rows, 'Nope')).toThrow(/no "Nope" row/);
  });

  it('extraEntries names what was left behind', () => {
    expect(extraEntries(['bridge', 'host'], ['host', 'bridge', 'noodara-net-x', 'leak', 'leak'])).toEqual([
      'leak',
      'noodara-net-x',
    ]);
  });
});

describe('reconcileLogChunks (20-02 H1)', () => {
  const clean = { inserted: 3, persistedChunks: 3, droppedChunks: 0, persistFailures: 0 };

  it('passes when every sink chunk is exactly one row', () => {
    expect(reconcileLogChunks(['a'], new Map([['a', clean]]), new Map([['a', 3]]))).toEqual([]);
  });

  it('names lost, duplicated, dropped, failed, unopened and foreign records', () => {
    const problems = reconcileLogChunks(
      ['a', 'b', 'c', 'd'],
      new Map([
        ['a', clean],
        ['b', { inserted: 2, persistedChunks: 3, droppedChunks: 1, persistFailures: 1 }],
        ['c', { ...clean, inserted: 0, persistedChunks: 0 }],
      ]),
      new Map([
        ['a', 4],
        ['b', 2],
        ['x', 1],
      ]),
    );
    expect(problems).toEqual([
      'a: 4 rows for 3 inserts',
      'b: 1 chunks dropped',
      'b: 1 chunk inserts failed',
      'b: sink persisted 3, writer inserted 2',
      'c: no log rows at all',
      'd: no log sink was opened',
      'x: 1 log rows of a deployment no request created',
    ]);
  });
});

describe('reconcileWebhookDeliveries (20-02 H1)', () => {
  it('passes when each push is one deployed row linked to its deployment', () => {
    expect(
      reconcileWebhookDeliveries(new Map([['d1', 'dep1']]), [{ deliveryId: 'd1', outcome: 'deployed', deploymentId: 'dep1' }]),
    ).toEqual([]);
  });

  it('names lost, duplicated, foreign, wrong-outcome and mislinked deliveries', () => {
    const problems = reconcileWebhookDeliveries(
      new Map([
        ['d1', 'dep1'],
        ['d2', 'dep2'],
        ['d3', 'dep3'],
      ]),
      [
        { deliveryId: 'd1', outcome: 'deployed', deploymentId: 'dep1' },
        { deliveryId: 'd1', outcome: 'deployed', deploymentId: 'dep1' },
        { deliveryId: 'd2', outcome: 'coalesced', deploymentId: 'depX' },
        { deliveryId: 'zz', outcome: 'deployed', deploymentId: 'depX' },
      ],
    );
    expect(problems).toEqual([
      'd1: 2 delivery rows',
      'zz: a delivery row no request issued',
      'd2: outcome coalesced, expected deployed',
      'd2: linked to depX, expected dep2',
      'd3: delivery lost',
      'two deliveries share one deployment',
    ]);
  });
});
