// T-5G-28-02 (05-28-PLAN.md): safeLocalStorage never throws regardless of the browser's storage
// availability -- server rendering (no `window`), a blocked-storage privacy profile (a
// `SecurityError` thrown by the `localStorage` accessor itself) and a full quota (`setItem`
// throwing). This suite runs in Vitest's `apps` project (node environment, no `window` global by
// default -- see first-trust.test.ts's own precedent), so `window` is stubbed per case via
// `vi.stubGlobal` rather than relying on jsdom.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { safeLocalStorage } from './safe-storage';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('safeLocalStorage', () => {
  it('returns null from getItem and no-ops setItem/removeItem without throwing when window is undefined (SSR)', () => {
    expect(typeof window).toBe('undefined');

    const storage = safeLocalStorage();

    expect(storage.getItem('noodara-first-trust:srv_1')).toBeNull();
    expect(() => {
      storage.setItem('noodara-first-trust:srv_1', '1');
    }).not.toThrow();
    expect(() => {
      storage.removeItem('noodara-first-trust:srv_1');
    }).not.toThrow();
  });

  it('returns null from getItem and no-ops setItem/removeItem without throwing when the localStorage accessor itself throws (blocked-storage privacy profile)', () => {
    const fakeWindow = {
      get localStorage(): never {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    };
    vi.stubGlobal('window', fakeWindow);

    const storage = safeLocalStorage();

    expect(storage.getItem('noodara-first-trust:srv_1')).toBeNull();
    expect(() => {
      storage.setItem('noodara-first-trust:srv_1', '1');
    }).not.toThrow();
    expect(() => {
      storage.removeItem('noodara-first-trust:srv_1');
    }).not.toThrow();
  });

  it('swallows a throwing setItem (quota exceeded) without throwing, while getItem/removeItem still reach the real backend', () => {
    const writes = new Map<string, string>([['existing', 'value']]);
    const fakeLocalStorage = {
      getItem: vi.fn((key: string) => writes.get(key) ?? null),
      setItem: vi.fn(() => {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      }),
      removeItem: vi.fn((key: string) => {
        writes.delete(key);
      }),
    };
    vi.stubGlobal('window', { localStorage: fakeLocalStorage });

    const storage = safeLocalStorage();

    expect(storage.getItem('existing')).toBe('value');
    expect(() => {
      storage.setItem('existing', 'new-value');
    }).not.toThrow();
    expect(fakeLocalStorage.setItem).toHaveBeenCalledWith('existing', 'new-value');
    expect(() => {
      storage.removeItem('existing');
    }).not.toThrow();
    expect(writes.has('existing')).toBe(false);
  });

  it('is structurally assignable to first-trust.ts\'s StorageLike parameter', () => {
    // Compile-time assertion: a real caller (the detail page, plan 05-29) must be able to pass
    // `safeLocalStorage()` anywhere a `StorageLike` (getItem/setItem) is expected without a cast.
    const storage: { getItem(key: string): string | null; setItem(key: string, value: string): void } =
      safeLocalStorage();

    expect(typeof storage.getItem).toBe('function');
    expect(typeof storage.setItem).toBe('function');
  });
});
