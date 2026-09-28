// 10-02-PLAN.md Task 1 (D-15). The site's own theme resolve/apply/persist primitives -- a
// localStorage-only variant of packages/ui/src/ThemeToggle.tsx's `applyPreferences`/
// `resolveSystemTheme` idiom. Unlike the panel app (apps/web), the site has no server and no
// `noodara-prefs` mirror cookie: `applySiteTheme` (below) is the ONLY writer of `data-theme`,
// the `dark` class and `colorScheme` after first paint, and `persistSiteTheme` is the only
// writer of localStorage, exactly one place each -- mirrored by
// apps/site/src/lib/theme-script.ts's own independent, pre-hydration bootstrap script (that file
// cannot import this module: it must run before any JS bundle is parsed).

/** The one storage key this app ever reads/writes for the theme preference. Its own key,
 *  distinct from `packages/ui/src/ThemeToggle.tsx`'s `noodara-theme` -- the site is a different
 *  origin from any panel install, so there is no reason (and no ability) to share a value. */
export const SITE_THEME_STORAGE_KEY = 'noodara-site-theme';

export type SiteTheme = 'light' | 'dark';

/** Reads the stored theme choice. Returns `null` for "nothing stored" AND "an unrecognised
 *  value" alike -- a caller always falls back to `resolveSystemTheme()` in either case. Never
 *  throws: a privacy-mode/blocked `localStorage` must never block rendering. */
export function readStoredTheme(): SiteTheme | null {
  try {
    const value = localStorage.getItem(SITE_THEME_STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

/** Resolves the OS-level theme preference. Never throws: a blocked `matchMedia` (some hardened
 *  browsers/extensions) falls back to 'light', matching the app-wide "never fails render" rule. */
export function resolveSystemTheme(): SiteTheme {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/** Pure decision function (no I/O): given an already-read stored value and system preference,
 *  decides the theme to apply on first paint. `stored` is typed as `string | null` (not
 *  `SiteTheme | null`) because the whole point of this function is to validate an arbitrary,
 *  possibly-tampered stored value -- narrowing the parameter type would just move the "what if
 *  it's garbage" question to the caller instead of answering it here. */
export function resolveInitialTheme({
  stored,
  systemDark,
}: {
  readonly stored: string | null;
  readonly systemDark: boolean;
}): SiteTheme {
  if (stored === 'light' || stored === 'dark') return stored;
  return systemDark ? 'dark' : 'light';
}

/** The single writer of `data-theme`, the `dark` class and `colorScheme` on `<html>` after first
 *  paint. Fumadocs UI's shipped CSS keys off the `.dark` class (RESEARCH.md Pitfall 5) while
 *  `packages/ui/tokens.css` keys off `[data-theme="dark"]` -- this function writes both in one
 *  place so neither stylesheet ever observes a torn state. */
export function applySiteTheme(theme: SiteTheme): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  if (theme === 'dark') {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }
  root.style.colorScheme = theme;
}

/** The single writer of `localStorage[SITE_THEME_STORAGE_KEY]`. Never throws: a full/blocked
 *  quota must never prevent the attribute writes `applySiteTheme` already made from sticking for
 *  the current page view, even if the choice won't survive a reload. */
export function persistSiteTheme(theme: SiteTheme): void {
  try {
    localStorage.setItem(SITE_THEME_STORAGE_KEY, theme);
  } catch {
    // Storage disabled or full -- the attribute writes already reflect the preference this load.
  }
}
