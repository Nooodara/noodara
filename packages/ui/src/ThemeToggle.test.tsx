import { PREFERENCES_COOKIE_NAME } from '@noodara/domain/preferences';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyPreferences, readPreferencesMirror, STORAGE_KEY } from './ThemeToggle.js';

// jsdom implements localStorage but not matchMedia -- every test stubs it via vi.stubGlobal
// (this plan's own read_first note). localStorage and document.documentElement's data-theme
// attribute are reset in beforeEach so tests never depend on execution order.
function stubMatchMedia(prefersDark: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: prefersDark,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

function clearPreferencesCookie(): void {
  document.cookie = `${PREFERENCES_COOKIE_NAME}=; Path=/; Max-Age=0`;
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-motion');
  document.documentElement.removeAttribute('data-density');
  clearPreferencesCookie();
  stubMatchMedia(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearPreferencesCookie();
});

// applyPreferences (09-07-PLAN.md Task 1, P17/D-12) -- the single browser write path for all three
// preferences, replacing the old data-theme-only effect as the codebase's only place that ever
// touches `<html>`'s data-theme/data-motion/data-density attributes, the noodara-theme localStorage
// key or the noodara-prefs cookie.
describe('applyPreferences', () => {
  it('sets data-theme, data-motion and data-density, the localStorage cache and the mirror cookie for an explicit dark/on/compact preference', () => {
    applyPreferences({ theme: 'dark', reduceMotion: 'on', density: 'compact' });

    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(document.documentElement).toHaveAttribute('data-motion', 'reduce');
    expect(document.documentElement).toHaveAttribute('data-density', 'compact');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('dark');
    expect(document.cookie).toContain(`${PREFERENCES_COOKIE_NAME}=dark.on.compact`);
  });

  it('resolves data-theme via matchMedia for auto, removes data-motion/data-density, clears localStorage and writes the auto/system/comfortable cookie', () => {
    stubMatchMedia(true);
    document.documentElement.setAttribute('data-motion', 'reduce');
    document.documentElement.setAttribute('data-density', 'compact');
    localStorage.setItem(STORAGE_KEY, 'dark');

    applyPreferences({ theme: 'auto', reduceMotion: 'system', density: 'comfortable' });

    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(document.documentElement).not.toHaveAttribute('data-motion');
    expect(document.documentElement).not.toHaveAttribute('data-density');
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(document.cookie).toContain(`${PREFERENCES_COOKIE_NAME}=auto.system.comfortable`);
  });

  it('writes the mirror cookie with Path=/, Max-Age=31536000 and SameSite=Lax, never HttpOnly, and no Secure over plain http', () => {
    const setCookieSpy = vi.spyOn(document, 'cookie', 'set');

    applyPreferences({ theme: 'light', reduceMotion: 'off', density: 'comfortable' });

    const written = setCookieSpy.mock.calls
      .map(([value]) => value)
      .find((value) => value.startsWith(`${PREFERENCES_COOKIE_NAME}=`));
    expect(written).toBeDefined();
    expect(written).toContain('Path=/');
    expect(written).toContain('Max-Age=31536000');
    expect(written).toContain('SameSite=Lax');
    expect(written).not.toContain('HttpOnly');
    expect(written).not.toContain('Secure');

    setCookieSpy.mockRestore();
  });

  it('adds Secure to the mirror cookie only when location.protocol is https:', () => {
    vi.stubGlobal('location', { protocol: 'https:' });
    const setCookieSpy = vi.spyOn(document, 'cookie', 'set');

    applyPreferences({ theme: 'light', reduceMotion: 'off', density: 'comfortable' });

    const written = setCookieSpy.mock.calls
      .map(([value]) => value)
      .find((value) => value.startsWith(`${PREFERENCES_COOKIE_NAME}=`));
    expect(written).toContain('; Secure');

    setCookieSpy.mockRestore();
  });

  it('still writes data-theme, data-motion and data-density when localStorage.setItem throws', () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    try {
      expect(() => {
        applyPreferences({ theme: 'dark', reduceMotion: 'on', density: 'compact' });
      }).not.toThrow();
      expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
      expect(document.documentElement).toHaveAttribute('data-motion', 'reduce');
      expect(document.documentElement).toHaveAttribute('data-density', 'compact');
    } finally {
      setItemSpy.mockRestore();
    }
  });

  it('still writes data-theme, data-motion and data-density when the document.cookie setter throws', () => {
    const setCookieSpy = vi.spyOn(document, 'cookie', 'set').mockImplementation(() => {
      throw new Error('cookie writes blocked');
    });

    try {
      expect(() => {
        applyPreferences({ theme: 'dark', reduceMotion: 'on', density: 'compact' });
      }).not.toThrow();
      expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
      expect(document.documentElement).toHaveAttribute('data-motion', 'reduce');
      expect(document.documentElement).toHaveAttribute('data-density', 'compact');
    } finally {
      setCookieSpy.mockRestore();
    }
  });
});

describe('readPreferencesMirror', () => {
  it('returns null when the noodara-prefs cookie is absent', () => {
    expect(readPreferencesMirror()).toBeNull();
  });

  it('returns the parsed preferences via the domain codec when the cookie is present', () => {
    document.cookie = `${PREFERENCES_COOKIE_NAME}=dark.on.compact; Path=/`;

    expect(readPreferencesMirror()).toEqual({ theme: 'dark', reduceMotion: 'on', density: 'compact' });
  });
});
