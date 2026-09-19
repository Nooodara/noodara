import { describe, expect, it } from 'vitest';
import { applyServerEvent, reconcileSnapshot, sortServers } from './server-store';
import type { ServerView } from './api-client';
import type { ServerEvent } from './server-events';

// Minimal, locally-built ServerView fixture -- no shared builder exists yet in apps/web (unlike
// packages/domain's tests/builders/ convention), and this file is the first consumer of the type
// in a test, so a small local factory is the right size for now. Every field a real GET
// /api/servers response would carry is present so a reducer bug can never hide behind an
// incomplete fixture.
function buildServer(overrides: Partial<ServerView> & Pick<ServerView, 'id' | 'name'>): ServerView {
  return {
    host: 'example.test',
    sshPort: 22,
    sshUser: 'root',
    status: 'PENDING',
    hostFingerprint: null,
    hostFingerprintCapturedAt: null,
    pendingFingerprint: null,
    pendingFingerprintSeenAt: null,
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
    lastSeenAt: null,
    lastErrorCode: null,
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
    credentialType: 'ssh_password',
    ...overrides,
  };
}

describe('applyServerEvent', () => {
  it('server.updated replaces the entry with the same id, keeping every other entry object-identical', () => {
    const alpha = buildServer({ id: 'a', name: 'Alpha' });
    const beta = buildServer({ id: 'b', name: 'Beta' });
    const list = [alpha, beta];

    const updatedAlpha = buildServer({ id: 'a', name: 'Alpha', status: 'CONNECTED' });
    const event: ServerEvent = { type: 'server.updated', server: updatedAlpha };

    const next = applyServerEvent(list, event);

    expect(next).toHaveLength(2);
    expect(next[0]).toBe(updatedAlpha);
    // The untouched entry keeps its exact object reference -- React must not re-render it.
    expect(next[1]).toBe(beta);
  });

  it('server.updated for an id absent from the list inserts it at the correct sorted position', () => {
    const alpha = buildServer({ id: 'a', name: 'Alpha' });
    const charlie = buildServer({ id: 'c', name: 'Charlie' });
    const list = [alpha, charlie];

    const beta = buildServer({ id: 'b', name: 'Beta' });
    const next = applyServerEvent(list, { type: 'server.updated', server: beta });

    expect(next.map((s) => s.name)).toEqual(['Alpha', 'Beta', 'Charlie']);
  });

  it('server.deleted removes the matching entry and leaves the rest identical', () => {
    const alpha = buildServer({ id: 'a', name: 'Alpha' });
    const beta = buildServer({ id: 'b', name: 'Beta' });
    const list = [alpha, beta];

    const next = applyServerEvent(list, { type: 'server.deleted', id: 'a' });

    expect(next).toHaveLength(1);
    expect(next[0]).toBe(beta);
  });

  it('server.deleted for an unknown id returns the original array reference unchanged', () => {
    const list = [buildServer({ id: 'a', name: 'Alpha' })];

    const next = applyServerEvent(list, { type: 'server.deleted', id: 'unknown-id' });

    expect(next).toBe(list);
  });

  it('server.discovery_progress is ignored and returns the original reference', () => {
    const list = [buildServer({ id: 'a', name: 'Alpha' })];

    const next = applyServerEvent(list, {
      type: 'server.discovery_progress',
      serverId: 'a',
      check: { id: 'hostname', status: 'pass', detail: 'ok', durationMs: 12 },
    });

    expect(next).toBe(list);
  });
});

describe('sortServers', () => {
  it('orders case-insensitively by name so "Alpha" and "alpha" sort adjacently', () => {
    const list = [
      buildServer({ id: '1', name: 'beta' }),
      buildServer({ id: '2', name: 'alpha' }),
      buildServer({ id: '3', name: 'Alpha' }),
    ];

    const sorted = sortServers(list);

    expect(sorted.map((s) => s.id)).toEqual(['2', '3', '1']);
  });
});

// .planning/debug/sse-lost-event-race.md: there is no event replay, so an event delivered while a
// `GET /api/servers` snapshot is in flight has to be folded onto that snapshot once it lands --
// without ever letting an event the snapshot already reflects regress it.
describe('reconcileSnapshot', () => {
  it('inserts a server created after the snapshot was read', () => {
    const snapshot = [buildServer({ id: '1', name: 'alpha' })];
    const created = buildServer({ id: '2', name: 'beta' });

    const result = reconcileSnapshot(snapshot, [{ type: 'server.updated', server: created }]);

    expect(result.map((s) => s.id)).toEqual(['1', '2']);
  });

  it('applies a buffered update that is newer than the snapshot entry', () => {
    const snapshot = [buildServer({ id: '1', name: 'alpha', status: 'CONNECTING', updatedAt: '2026-09-19T10:00:00.000Z' })];
    const newer = buildServer({ id: '1', name: 'alpha', status: 'CONNECTED', updatedAt: '2026-09-19T10:00:05.000Z' });

    const result = reconcileSnapshot(snapshot, [{ type: 'server.updated', server: newer }]);

    expect(result[0]?.status).toBe('CONNECTED');
  });

  it('ignores a buffered update that is older than the snapshot entry', () => {
    const snapshot = [buildServer({ id: '1', name: 'alpha', status: 'CONNECTED', updatedAt: '2026-09-19T10:00:05.000Z' })];
    const older = buildServer({ id: '1', name: 'alpha', status: 'CONNECTING', updatedAt: '2026-09-19T10:00:00.000Z' });

    const result = reconcileSnapshot(snapshot, [{ type: 'server.updated', server: older }]);

    expect(result[0]?.status).toBe('CONNECTED');
  });

  it('applies a buffered update carrying the same updatedAt as the snapshot entry', () => {
    const at = '2026-09-19T10:00:00.000Z';
    const snapshot = [buildServer({ id: '1', name: 'alpha', status: 'PENDING', updatedAt: at })];
    const same = buildServer({ id: '1', name: 'alpha', status: 'CONNECTING', updatedAt: at });

    const result = reconcileSnapshot(snapshot, [{ type: 'server.updated', server: same }]);

    expect(result[0]?.status).toBe('CONNECTING');
  });

  it('removes a server whose deletion was buffered, even though the snapshot still lists it', () => {
    const snapshot = [buildServer({ id: '1', name: 'alpha' }), buildServer({ id: '2', name: 'beta' })];

    const result = reconcileSnapshot(snapshot, [{ type: 'server.deleted', id: '1' }]);

    expect(result.map((s) => s.id)).toEqual(['2']);
  });

  it('folds buffered events in arrival order, so an update followed by its deletion ends deleted', () => {
    const created = buildServer({ id: '9', name: 'short-lived' });
    const events: ServerEvent[] = [
      { type: 'server.updated', server: created },
      { type: 'server.deleted', id: '9' },
    ];

    expect(reconcileSnapshot([], events)).toEqual([]);
  });

  it('returns the snapshot itself when nothing was buffered', () => {
    const snapshot = [buildServer({ id: '1', name: 'alpha' })];

    expect(reconcileSnapshot(snapshot, [])).toBe(snapshot);
  });
});
