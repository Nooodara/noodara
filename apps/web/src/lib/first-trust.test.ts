// RED for 05-19-PLAN.md Task 1 -- shouldShowFirstTrustNotice/dismissFirstTrustNotice don't exist
// yet. Covers 05-UI-SPEC.md SS2.5 layout position 1 / SS5.2: the D-02 one-time notice is shown
// exactly once per server, its dismissal is client-side and cosmetic only (never touches the
// permanent fingerprint row in the Connection group), and a storage backend that throws (private
// browsing, a full quota) degrades to showing the notice rather than crashing the detail page.
import { describe, expect, it } from 'vitest';
import { dismissFirstTrustNotice, shouldShowFirstTrustNotice, type StorageLike } from './first-trust';

// A minimal in-memory fake -- the real accessor (`window.localStorage`) is only ever supplied by
// the detail page itself, never reached from this unit test (no DOM needed here).
function fakeStorage(): StorageLike & { readonly writes: Record<string, string> } {
  const writes: Record<string, string> = {};
  return {
    writes,
    getItem: (key) => (key in writes ? (writes[key] ?? null) : null),
    setItem: (key, value) => {
      writes[key] = value;
    },
  };
}

function throwingStorage(): StorageLike {
  return {
    getItem: () => {
      throw new Error('storage disabled');
    },
    setItem: () => {
      throw new Error('storage disabled');
    },
  };
}

describe('shouldShowFirstTrustNotice', () => {
  it('is true when hostFingerprintCapturedAt is set and no dismissal is recorded for the server', () => {
    const storage = fakeStorage();
    expect(shouldShowFirstTrustNotice(storage, 'server-a', '2026-09-19T00:00:00.000Z')).toBe(true);
  });

  it('is false once a dismissal has been recorded for that same server id', () => {
    const storage = fakeStorage();
    dismissFirstTrustNotice(storage, 'server-a');
    expect(shouldShowFirstTrustNotice(storage, 'server-a', '2026-09-19T00:00:00.000Z')).toBe(false);
  });

  it('stays true for a different server id even after another server was dismissed', () => {
    const storage = fakeStorage();
    dismissFirstTrustNotice(storage, 'server-a');
    expect(shouldShowFirstTrustNotice(storage, 'server-b', '2026-09-19T00:00:00.000Z')).toBe(true);
  });

  it('is false when hostFingerprintCapturedAt is null, regardless of dismissal state', () => {
    const dismissedStorage = fakeStorage();
    dismissFirstTrustNotice(dismissedStorage, 'server-a');
    expect(shouldShowFirstTrustNotice(dismissedStorage, 'server-a', null)).toBe(false);

    const freshStorage = fakeStorage();
    expect(shouldShowFirstTrustNotice(freshStorage, 'server-a', null)).toBe(false);
  });

  it('degrades to showing the notice (never throws) when the storage backend throws', () => {
    expect(() => shouldShowFirstTrustNotice(throwingStorage(), 'server-a', '2026-09-19T00:00:00.000Z')).not.toThrow();
    expect(shouldShowFirstTrustNotice(throwingStorage(), 'server-a', '2026-09-19T00:00:00.000Z')).toBe(true);
  });

  it('dismissFirstTrustNotice never throws when the storage backend throws on write', () => {
    expect(() => {
      dismissFirstTrustNotice(throwingStorage(), 'server-a');
    }).not.toThrow();
  });
});

describe('dismissFirstTrustNotice', () => {
  it('writes only a boolean-ish marker, never a fingerprint, hostname or any other server data', () => {
    const storage = fakeStorage();
    dismissFirstTrustNotice(storage, 'server-a');

    const values = Object.values(storage.writes);
    expect(values).toHaveLength(1);
    // The stored value carries no server-derived content at all -- just a fixed marker.
    expect(values[0]).toBe('1');
  });

  it('keys the marker by server id, so the same browser can independently dismiss two servers', () => {
    const storage = fakeStorage();
    dismissFirstTrustNotice(storage, 'server-a');
    dismissFirstTrustNotice(storage, 'server-b');

    expect(Object.keys(storage.writes)).toHaveLength(2);
  });
});
