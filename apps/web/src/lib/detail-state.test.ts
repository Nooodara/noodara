// RED for Task 1 (05-14-PLAN.md) -- `deriveDetailState`/`derivePrimaryAction` don't exist yet.
// Covers 05-UI-SPEC.md SS2.5/D-11/D-12's five detail states and the per-status primary-action
// table, exhaustively over every `ServerStatus` for `derivePrimaryAction` (a new domain status is
// a compile error against the map itself, but this file still asserts every existing one at
// runtime by iterating the domain package's own `SERVER_STATUSES` tuple, matching
// `packages/ui/src/tone.test.ts`'s established precedent for the same class of exhaustiveness).
import { describe, expect, it } from 'vitest';
import { SERVER_STATUSES, type ServerStatus } from '@noodara/domain/server';
import { deriveDetailState, derivePrimaryAction, type PrimaryAction } from './detail-state';
import type { ServerView } from './api-client';

// Minimal, locally-built ServerView fixture -- same size/shape precedent as
// `apps/web/src/lib/server-store.test.ts`'s own `buildServer` (no shared builder exists yet).
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
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    credentialType: 'ssh_password',
    ...overrides,
  };
}

describe('deriveDetailState', () => {
  it('returns never-discovered when hostname and lastErrorCode are both null, for any status', () => {
    for (const status of SERVER_STATUSES) {
      const server = buildServer({ id: 'a', name: 'a', status, hostname: null, lastErrorCode: null });
      expect(deriveDetailState(server)).toBe('never-discovered');
    }
  });

  it('returns failed-no-history when lastErrorCode is set and hostname is null', () => {
    const server = buildServer({ id: 'a', name: 'a', status: 'ERROR', hostname: null, lastErrorCode: 'AUTH_FAILED' });
    expect(deriveDetailState(server)).toBe('failed-no-history');
  });

  it('returns failed-with-history when lastErrorCode is set and hostname is non-null', () => {
    const server = buildServer({
      id: 'a',
      name: 'a',
      status: 'ERROR',
      hostname: 'srv-1',
      lastErrorCode: 'CONNECT_TIMEOUT',
    });
    expect(deriveDetailState(server)).toBe('failed-with-history');
  });

  it('returns discovered when hostname is non-null and lastErrorCode is null', () => {
    const server = buildServer({ id: 'a', name: 'a', status: 'CONNECTED', hostname: 'srv-1', lastErrorCode: null });
    expect(deriveDetailState(server)).toBe('discovered');
  });

  it('returns host-key-changed regardless of history, so the dedicated banner wins over the generic one', () => {
    const noHistory = buildServer({ id: 'a', name: 'a', status: 'ERROR', hostname: null, lastErrorCode: 'HOST_KEY_CHANGED' });
    const withHistory = buildServer({
      id: 'a',
      name: 'a',
      status: 'ERROR',
      hostname: 'srv-1',
      lastErrorCode: 'HOST_KEY_CHANGED',
    });

    expect(deriveDetailState(noHistory)).toBe('host-key-changed');
    expect(deriveDetailState(withHistory)).toBe('host-key-changed');
  });

  // D-11 (02-CONTEXT.md)/05-UI-SPEC.md SS5.1: UNSUPPORTED_OS lands the server on CONNECTED, not
  // ERROR -- `lastErrorCode` still carries the code as a warning, so a literal "lastErrorCode set
  // -> failed" branch would wrongly show the generic error banner over a server whose connection
  // and discovery both actually succeeded. This is never classified as a failed-* state.
  it('returns discovered (never a failed-* state) when lastErrorCode is UNSUPPORTED_OS and a discovery exists', () => {
    const server = buildServer({
      id: 'a',
      name: 'a',
      status: 'CONNECTED',
      hostname: 'srv-1',
      lastErrorCode: 'UNSUPPORTED_OS',
    });
    expect(deriveDetailState(server)).toBe('discovered');
  });
});

describe('derivePrimaryAction', () => {
  // The literal per-status table (05-UI-SPEC.md SS2.5). DISCONNECTED is not named in that table,
  // but `packages/domain/src/server/server-state.ts`'s TRANSITIONS only ever lets it reach
  // CONNECTING -- the same single edge PENDING has -- so it gets PENDING's identical un-disabled
  // "Connect" action rather than being left out of the `satisfies Record<ServerStatus, ...>` map
  // below (which would be a compile error).
  const EXPECTED: Record<ServerStatus, PrimaryAction | null> = {
    PENDING: { label: 'Connect', endpoint: '/connect', disabled: false },
    CONNECTING: { label: 'Connect', endpoint: '/connect', disabled: true },
    CONNECTED: { label: 'Re-run discovery', endpoint: '/discover', disabled: false },
    DISCONNECTED: { label: 'Connect', endpoint: '/connect', disabled: false },
    UNREACHABLE: { label: 'Retry', endpoint: '/connect', disabled: false },
    ERROR: { label: 'Retry', endpoint: '/connect', disabled: false },
  };

  it.each(SERVER_STATUSES)('resolves the exact action for %s (a non-HOST_KEY_CHANGED lastErrorCode)', (status) => {
    const server = buildServer({
      id: 'a',
      name: 'a',
      status,
      lastErrorCode: status === 'ERROR' ? 'AUTH_FAILED' : null,
    });
    expect(derivePrimaryAction(server)).toEqual(EXPECTED[status]);
  });

  it('returns null for ERROR with lastErrorCode HOST_KEY_CHANGED and a pending fingerprint -- the action lives in the banner, not the toolbar', () => {
    const server = buildServer({
      id: 'a',
      name: 'a',
      status: 'ERROR',
      lastErrorCode: 'HOST_KEY_CHANGED',
      pendingFingerprint: 'SHA256:observed0000000000000000000000000000000000',
    });
    expect(derivePrimaryAction(server)).toBeNull();
  });

  it('returns Retry for ERROR/HOST_KEY_CHANGED once pendingFingerprint is null -- nothing left to trust after an identity-changing edit (CR-01)', () => {
    const server = buildServer({
      id: 'a',
      name: 'a',
      status: 'ERROR',
      lastErrorCode: 'HOST_KEY_CHANGED',
      pendingFingerprint: null,
    });
    expect(derivePrimaryAction(server)).toEqual({ label: 'Retry', endpoint: '/connect', disabled: false });
  });
});
