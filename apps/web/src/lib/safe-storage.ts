// T-5G-28-02 (05-28-PLAN.md, CLAUDE.md SS2.2 "ningun fallo de infraestructura... tumba la API" --
// extended here to the browser's own storage backend): a `Storage`-shaped accessor that never
// throws, regardless of why `localStorage` is unavailable -- no `window` (server rendering), a
// blocked-storage privacy profile (the `localStorage` accessor itself throwing a `SecurityError`)
// or a full quota (`setItem` throwing). Every unavailable case degrades to `getItem` returning
// `null` -- never `undefined`, never a thrown error -- so this substitutes cleanly anywhere
// first-trust.ts's `StorageLike` parameter (`getItem`/`setItem`) is expected, without widening
// that parameter's type to `any`.
export function safeLocalStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  return {
    getItem(key: string): string | null {
      try {
        if (typeof window === 'undefined') return null;
        return window.localStorage.getItem(key);
      } catch {
        // Storage disabled/blocked -- degrade to "nothing stored", never throw.
        return null;
      }
    },
    setItem(key: string, value: string): void {
      try {
        if (typeof window === 'undefined') return;
        window.localStorage.setItem(key, value);
      } catch {
        // Storage disabled, blocked, or quota exceeded -- a failed write just means whatever this
        // was recording (e.g. a dismissal marker) reappears next time, never an unhandled throw.
      }
    },
    removeItem(key: string): void {
      try {
        if (typeof window === 'undefined') return;
        window.localStorage.removeItem(key);
      } catch {
        // Same degrade-silently rule as getItem/setItem above.
      }
    },
  };
}
