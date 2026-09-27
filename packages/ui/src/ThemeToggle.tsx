import { useEffect, useRef, useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import {
  DEFAULT_PREFERENCES,
  PREFERENCES_COOKIE_MAX_AGE_SECONDS,
  PREFERENCES_COOKIE_NAME,
  parsePreferencesCookieValue,
  preferencesToRootAttributes,
  serializePreferencesCookieValue,
  type Preferences,
} from '@noodara/domain/preferences';
import { Button } from './Button.js';

// The single storage key this whole codebase ever reads/writes for the theme preference --
// exported (not re-declared) so ThemeToggle.test.tsx never repeats the literal string, keeping
// exactly one place this key is spelled out (this file's own acceptance criteria: `grep -rc
// "noodara-theme" packages/ui/src` is 1). apps/web/src/lib/theme-script.ts's first-paint
// bootstrap script reads the identical literal independently, by design -- that file runs before
// any JS bundle (this module included) is even parsed, so it cannot import from here.
export const STORAGE_KEY = 'noodara-theme';

type StoredTheme = 'light' | 'dark';
type Mode = StoredTheme | 'system';

// Never trusts a tampered/foreign stored value -- only the two literal strings this component
// itself ever writes are accepted back; anything else (missing key, or a stray value from a
// browser extension/older version) falls back to 'system' exactly like theme-script.ts's own
// bootstrap does for a missing key.
function readStoredTheme(): StoredTheme | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

function resolveSystemTheme(): StoredTheme {
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
 * the cookie -- both of ThemeToggle's own write sites (the click handler and the mount-settle
 * effect below) route through this one function instead of writing directly. The server sets the
 * identical cookie, via the same domain codec, on `PATCH /api/account/preferences` responses
 * (09-08) -- this is the browser-side half of that single source of truth.
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

function nextMode(mode: Mode): Mode {
  if (mode === 'light') {
    return 'dark';
  }
  if (mode === 'dark') {
    return 'system';
  }
  return 'light';
}

const MODE_LABEL: Record<Mode, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
};

const MODE_ICON = { light: Sun, dark: Moon, system: Monitor } as const;
const ICON_PROPS = { 'aria-hidden': true, size: 16, strokeWidth: 1.5 } as const;

export interface ThemeToggleProps {
  readonly 'data-testid'?: string;
}

// ThemeToggle (05-UI-SPEC.md Theme switching, Component Inventory) -- still the only component in
// this codebase that ever writes localStorage's noodara-theme key or <html>'s
// data-theme/data-motion/data-density attributes after the initial page load, now entirely
// through `applyPreferences` above (P17, D-12): its own click handler and mount-settle effect
// never call `setAttribute`/`localStorage` directly, they only decide *which* `Preferences` value
// to apply. Its only counterpart is apps/web's first-paint bootstrap script
// (apps/web/src/lib/theme-script.ts, THEME_BOOTSTRAP_SCRIPT), which reads the same
// localStorage/cookie once, synchronously, before hydration, and never writes to either again.
// This component itself is superseded by 09-12's Settings `SegmentedControl` (D-12) -- until then
// it keeps the app fully working, cycling light -> dark -> system and preserving whichever
// reduceMotion/density the `noodara-prefs` mirror cookie already carries.
export function ThemeToggle({ 'data-testid': testId }: ThemeToggleProps) {
  // WR-C-01: the server never has a `localStorage` to read, so the initial render must never
  // depend on it -- 'system' is a fixed, environment-independent default, identical on the
  // server and on the very first client render (no hydration mismatch). The real stored
  // preference (if any) is adopted a moment later, in the mount effect below.
  const [mode, setMode] = useState<Mode>('system');
  // Guards the data-theme-writing effect below against clobbering
  // `THEME_BOOTSTRAP_SCRIPT`'s (apps/web/src/lib/theme-script.ts) already-correct pre-hydration
  // value with a wrong system-default one, for the single frame between this component settling
  // on 'system' at mount and the storage-read effect adopting the real stored value. `false`
  // only for that one frame; the very first data-theme effect run flips it and returns without
  // writing, and every run after that (including the one the storage-read effect's `setMode`
  // triggers) writes normally.
  const settledRef = useRef(false);

  useEffect(() => {
    const stored = readStoredTheme();
    if (stored !== null) {
      setMode(stored);
    }
    // No stored value -- 'system' was already correct and THEME_BOOTSTRAP_SCRIPT already applied
    // the matching data-theme before hydration; nothing else to settle.
  }, []);

  useEffect(() => {
    if (!settledRef.current) {
      settledRef.current = true;
      return;
    }
    // Preserves whichever reduceMotion/density the mirror cookie already carries -- this effect
    // (and the click handler below) only ever changes theme, never the other two preferences.
    const current = readPreferencesMirror() ?? DEFAULT_PREFERENCES;
    applyPreferences({ ...current, theme: mode === 'system' ? 'auto' : mode });
  }, [mode]);

  const handleClick = () => {
    setMode(nextMode(mode));
  };

  const Icon = MODE_ICON[mode];

  return (
    <Button
      variant="ghost"
      data-testid={testId}
      aria-label={`Theme: ${MODE_LABEL[mode]}`}
      onClick={handleClick}
    >
      <Icon {...ICON_PROPS} />
    </Button>
  );
}
