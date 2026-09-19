// D-02 (05-UI-SPEC.md SS2.5 layout position 1 / SS5.2): whether the detail page's one-time
// first-trust notice shows for a given server. Pure decision logic, storage-injected (never
// reaches a real browser storage object itself) so it is testable in the node environment and
// stays independent of any DOM.
//
// SECURITY: dismissal is cosmetic client-side state only -- it never changes server state, never
// reads or writes the fingerprint itself, and no server data is ever written to storage here (no
// fingerprint, no hostname, no host:port -- just a fixed per-server marker). The permanent
// fingerprint row in the Connection group (ServerFacts.tsx) is unaffected by dismissal and stays
// visible regardless.
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEY_PREFIX = 'noodara-first-trust:';
// The one value this module ever writes -- a fixed marker, never anything server-derived.
const DISMISSED_MARKER = '1';

function keyFor(serverId: string): string {
  return `${KEY_PREFIX}${serverId}`;
}

/**
 * True exactly when `hostFingerprintCapturedAt` is set (a fingerprint has genuinely been trusted
 * on first connect) and no dismissal is recorded for `serverId` in `storage`. A storage backend
 * that throws (private browsing, a blocked/full quota) degrades to showing the notice -- never to
 * a crash on the detail page -- since failing safe here means "show the security-relevant notice
 * again", not "silently hide it".
 */
export function shouldShowFirstTrustNotice(
  storage: StorageLike,
  serverId: string,
  hostFingerprintCapturedAt: string | null,
): boolean {
  if (hostFingerprintCapturedAt === null) {
    return false;
  }

  try {
    return storage.getItem(keyFor(serverId)) === null;
  } catch {
    return true;
  }
}

/** Records the dismissal for `serverId`, keyed independently of every other server id. Swallows a
 *  throwing storage backend silently -- a failed write just means the notice reappears next time,
 *  never an unhandled exception surfacing on the detail page. */
export function dismissFirstTrustNotice(storage: StorageLike, serverId: string): void {
  try {
    storage.setItem(keyFor(serverId), DISMISSED_MARKER);
  } catch {
    // Storage disabled or full -- see doc comment above.
  }
}
