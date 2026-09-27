// The Appearance preferences write/read path (D-09, D-12, P17). This module no longer owns a
// component -- Settings' three `SegmentedControl` rows (apps/web's SettingsGroups.tsx, via
// apps/web/src/lib/appearance.ts's `updateAppearancePreference`) are the only Appearance UI --
// but it stays the single browser write path (`applyPreferences`) and the single mirror-cookie
// reader (`readPreferencesMirror`) every caller routes through, exactly as before 09-12.
import {
  PREFERENCES_COOKIE_MAX_AGE_SECONDS,
  PREFERENCES_COOKIE_NAME,
  parsePreferencesCookieValue,
  preferencesToRootAttributes,
  serializePreferencesCookieValue,
  type Preferences,
} from '@noodara/domain/preferences';

// The single storage key this whole codebase ever reads/writes for the theme preference --
// exported (not re-declared) so ThemeToggle.test.tsx never repeats the literal string, keeping
// exactly one place this key is spelled out (this file's own acceptance criteria: `grep -rc
// "noodara-theme" packages/ui/src` is 1). apps/web/src/lib/theme-script.ts's first-paint
// bootstrap script reads the identical literal independently, by design -- that file runs before
// any JS bundle (this module included) is even parsed, so it cannot import from here.
// `applyPreferences` below is the only writer of this key.
export const STORAGE_KEY = 'noodara-theme';

function resolveSystemTheme(): 'light' | 'dark' {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function readCookieValue(name: string): string | undefined {
  try {
    for (const entry of document.cookie.split('; ')) {
      const separatorIndex = entry.indexOf('=');
      if (separatorIndex === -1) {
        continue;
      }
      if (entry.slice(0, separatorIndex) === name) {
        return entry.slice(separatorIndex + 1);
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * readPreferencesMirror -- reads the `noodara-prefs` mirror cookie (D-09) through the domain
 * codec. Returns `null` only when the cookie is entirely absent, so a caller can distinguish "no
 * mirror yet" (fall back to `DEFAULT_PREFERENCES`) from "mirror present but corrupted" (the codec
 * already resolves that to a full, valid `Preferences` object, never raw/tampered data, T-09-06).
 */
export function readPreferencesMirror(): Preferences | null {
  return parsePreferencesCookieValue(readCookieValue(PREFERENCES_COOKIE_NAME));
}

/**
 * applyPreferences -- the single browser write path (P17, D-12) for all three preferences: the
 * `data-theme`/`data-motion`/`data-density` attributes on `<html>`, the `noodara-theme`
 * localStorage cache (a cache only -- the cookie mirror below is the source SSR reads) and the
 * `noodara-prefs` mirror cookie itself. No other function in this codebase ever calls
 * `setAttribute`/`removeAttribute` for these three attributes or writes either the storage key or
 * the cookie -- every caller (Settings' `SegmentedControl`s via
 * apps/web/src/lib/appearance.ts's `updateAppearancePreference`) routes through this one function
 * instead of writing directly. The server sets the identical cookie, via the same domain codec, on
 * `PATCH /api/account/preferences` responses (09-08) -- this is the browser-side half of that
 * single source of truth.
 *
 * Every storage/cookie write is independently try/catch-guarded: a throwing `localStorage`
 * (private mode, full quota) or a throwing `document.cookie` setter (a hardened browser or
 * extension) must never prevent the `<html>` attribute writes that give the user their theme back
 * at all.
 */
export function applyPreferences(preferences: Preferences): void {
  const attrs = preferencesToRootAttributes(preferences);
  const root = document.documentElement;

  // tokens.css only ever reads an explicit 'light'/'dark' -- 'auto' never reaches the DOM as a
  // literal value, so a missing data-theme here is always resolved via matchMedia first.
  root.setAttribute('data-theme', attrs['data-theme'] ?? resolveSystemTheme());

  if (attrs['data-motion'] !== undefined) {
    root.setAttribute('data-motion', attrs['data-motion']);
  } else {
    root.removeAttribute('data-motion');
  }

  if (attrs['data-density'] !== undefined) {
    root.setAttribute('data-density', attrs['data-density']);
  } else {
    root.removeAttribute('data-density');
  }

  try {
    if (preferences.theme === 'light' || preferences.theme === 'dark') {
      localStorage.setItem(STORAGE_KEY, preferences.theme);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Storage disabled or full -- the attribute writes above already reflect the preference.
  }

  try {
    // Never HttpOnly (a page script must be able to read it back, e.g. this very function on the
    // next load); Secure only added over https so this keeps working on a plain-http local
    // install (docs/adr, T-09-23: no sensitive data ever rides in this cookie either way).
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${PREFERENCES_COOKIE_NAME}=${serializePreferencesCookieValue(preferences)}; Path=/; Max-Age=${String(PREFERENCES_COOKIE_MAX_AGE_SECONDS)}; SameSite=Lax${secure}`;
  } catch {
    // Cookie writes blocked -- the attribute writes above already reflect the preference.
  }
}

// D-12 (09-12-PLAN.md Task 2): the cyclic icon-button component that used to live here is gone --
// Settings' three `SegmentedControl` rows are the only Appearance UI now, and `applyPreferences`
// above is their single write path (P17), same function this module always exported for exactly
// this reason. This module keeps its name and stays the single write path apps/web's first-paint
// bootstrap script (apps/web/src/lib/theme-script.ts, THEME_BOOTSTRAP_SCRIPT) has a matching,
// independent read-once-before-hydration counterpart for.
