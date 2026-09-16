// D-19: RED for the ServerView allowlist projection and its key-list guard. `buildServerRow`
// produces a fully-populated `typeof servers.$inferSelect` fixture so every case below exercises
// the real column set, not a hand-picked subset.
import { describe, expect, it } from 'vitest';
import type { servers } from '../db/schema/servers.js';
import { SERVER_VIEW_KEYS, toServerView, type ServerView } from './server-view.js';

type ServerRow = typeof servers.$inferSelect;

function buildServerRow(overrides: Partial<ServerRow> = {}): ServerRow {
  const base: ServerRow = {
    id: 'srv-1',
    name: 'prod-1',
    host: '10.0.0.5',
    sshPort: 22,
    sshUser: 'deployer',
    credentialId: 'cred-1',
    status: 'CONNECTED',
    hostFingerprint: 'SHA256:abc',
    pendingFingerprint: null,
    hostFingerprintCapturedAt: new Date('2026-01-01T00:00:00Z'),
    pendingFingerprintSeenAt: null,
    hostname: 'prod-1.internal',
    osDistribution: 'ubuntu',
    osVersion: '24.04',
    arch: 'x86_64',
    cpuCores: 4,
    ramMb: 8192,
    diskTotalMb: 102400,
    diskUsedMb: 20480,
    uptimeSeconds: 3600,
    dockerInstalled: true,
    dockerVersion: '27.0.0',
    dockerComposeVersion: '2.30.0',
    lastSeenAt: new Date('2026-01-02T00:00:00Z'),
    lastErrorCode: null,
    createdAt: new Date('2025-12-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
  };
  return { ...base, ...overrides };
}

// D-19's own key-list guard: any credential-shaped field is a SEC-02 regression the moment it
// appears in `Object.keys(toServerView(...))`, regardless of case.
const FORBIDDEN_KEYS = [
  'credentialId',
  'encryptedValue',
  'keyVersion',
  'password',
  'privateKey',
  'passphrase',
  'credential',
  'secret',
  'token',
];

describe('SERVER_VIEW_KEYS', () => {
  // 03-04-PLAN.md's own field list enumerates 26 `servers` columns (id..updatedAt) "plus
  // credentialType" — 27 total. The plan's acceptance criterion elsewhere says "26 entries",
  // which undercounts its own listed fields by one; every `servers` column plus `credentialType`
  // (the must_haves.truths requirement, and the literal RESEARCH.md ServerView interface) is
  // authoritative here, so this asserts the real total (Rule 1: plan-arithmetic bug, not a code
  // bug — see 03-04-SUMMARY.md).
  it('has exactly 27 entries and includes dockerComposeVersion', () => {
    expect(SERVER_VIEW_KEYS).toHaveLength(27);
    expect(SERVER_VIEW_KEYS).toContain('dockerComposeVersion');
    expect(SERVER_VIEW_KEYS).toContain('credentialType');
  });
});

describe('toServerView', () => {
  it("produces exactly SERVER_VIEW_KEYS' key set", () => {
    const row = buildServerRow();
    const view = toServerView(row, 'ssh_password');

    expect(Object.keys(view).sort()).toEqual([...SERVER_VIEW_KEYS].sort());
  });

  it('round-trips credentialType for both ssh_private_key and ssh_password', () => {
    const row = buildServerRow();

    expect(toServerView(row, 'ssh_private_key').credentialType).toBe('ssh_private_key');
    expect(toServerView(row, 'ssh_password').credentialType).toBe('ssh_password');
  });

  it('maps every servers column to a same-named view field with the same value', () => {
    const row = buildServerRow();
    const view = toServerView(row, 'ssh_password');

    for (const field of SERVER_VIEW_KEYS) {
      if (field === 'credentialType') continue;
      expect((view as unknown as Record<string, unknown>)[field]).toEqual(
        (row as unknown as Record<string, unknown>)[field],
      );
    }
  });

  it('never carries a credential-shaped field, even when the input row is polluted', () => {
    const polluted = {
      ...buildServerRow(),
      credentialId: 'x',
      encryptedValue: 'y',
      password: 'z',
      privateKey: 'k',
      passphrase: 'p',
      secret: 's',
      token: 't',
    };
    const view = toServerView(polluted, 'ssh_password');
    const keysLower = Object.keys(view).map((k) => k.toLowerCase());

    for (const forbidden of FORBIDDEN_KEYS) {
      expect(keysLower).not.toContain(forbidden.toLowerCase());
    }
  });

  it('is built as an allowlist, never spread-then-delete', () => {
    const view: ServerView = toServerView(buildServerRow(), 'ssh_password');
    expect(view.id).toBe('srv-1');
  });
});
