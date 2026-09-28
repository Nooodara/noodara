// @vitest-environment jsdom
// 10-02-PLAN.md Task 1 (D-15): the site's own theme resolve/apply/persist primitives -- a
// localStorage-only variant of packages/ui/src/ThemeToggle.tsx's `applyPreferences`/
// `resolveSystemTheme` idiom (this app has no server, so there is no cookie mirror to write).
// RED: written before site-theme.ts exists.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applySiteTheme,
  persistSiteTheme,
  readStoredTheme,
  resolveInitialTheme,
  resolveSystemTheme,
  SITE_THEME_STORAGE_KEY,
} from './site-theme';

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.classList.remove('dark');
  document.documentElement.style.colorScheme = '';
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('SITE_THEME_STORAGE_KEY', () => {
  it('is its own key, distinct from the panel app', () => {
    expect(SITE_THEME_STORAGE_KEY).toBe('noodara-site-theme');
  });
});

describe('resolveInitialTheme', () => {
  it('prefers an explicit stored "dark" over systemDark:false', () => {
    expect(resolveInitialTheme({ stored: 'dark', systemDark: false })).toBe('dark');
  });

  it('falls back to systemDark:true when nothing is stored', () => {
    expect(resolveInitialTheme({ stored: null, systemDark: true })).toBe('dark');
  });

  it('falls back to systemDark:false when nothing is stored', () => {
    expect(resolveInitialTheme({ stored: null, systemDark: false })).toBe('light');
  });

  it('ignores an unrecognised stored value and falls back to systemDark', () => {
    expect(resolveInitialTheme({ stored: 'bogus', systemDark: false })).toBe('light');
  });
});

describe('applySiteTheme', () => {
  it('sets html[data-theme="dark"], adds the dark class and sets colorScheme dark', () => {
    applySiteTheme('dark');

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });

  it('sets html[data-theme="light"], removes the dark class and sets colorScheme light', () => {
    applySiteTheme('dark');
    applySiteTheme('light');

    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe('light');
  });
});

describe('persistSiteTheme', () => {
  it('writes localStorage[SITE_THEME_STORAGE_KEY]', () => {
    persistSiteTheme('dark');
    expect(localStorage.getItem(SITE_THEME_STORAGE_KEY)).toBe('dark');
  });

  it('never throws when localStorage.setItem throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });

    expect(() => {
      persistSiteTheme('dark');
    }).not.toThrow();
  });
});

describe('readStoredTheme', () => {
  it('returns null when nothing is stored', () => {
    expect(readStoredTheme()).toBeNull();
  });

  it('returns the stored theme when valid', () => {
    localStorage.setItem(SITE_THEME_STORAGE_KEY, 'dark');
    expect(readStoredTheme()).toBe('dark');
  });

  it('returns null and never throws when localStorage.getItem throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });

    expect(readStoredTheme()).toBeNull();
  });
});

describe('resolveSystemTheme', () => {
  it('returns "light" and never throws when matchMedia throws', () => {
    vi.stubGlobal('matchMedia', () => {
      throw new Error('blocked');
    });

    expect(resolveSystemTheme()).toBe('light');
  });

  it('returns "dark" when matchMedia reports prefers-color-scheme: dark', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: true, media: query }));
    expect(resolveSystemTheme()).toBe('dark');
  });
});
