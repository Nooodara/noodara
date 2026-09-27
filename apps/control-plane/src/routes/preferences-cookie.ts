// D-09: builds the `noodara-prefs` mirror cookie's Set-Cookie value for the server responses
// (`GET`/`PATCH /api/account/preferences`), from the same domain codec and constants
// (`@noodara/domain/preferences`) the browser writer (packages/ui/src/ThemeToggle.tsx's
// applyPreferences) uses -- the two must produce equivalent cookies (same segments, same
// attribute order). Deliberately non-HttpOnly (T-09-23, accepted): a page script must be able to
// read this cookie back on the next load, and its value only ever contains the three closed enums
// (theme.reduceMotion.density), never a session identifier or any other sensitive data.
import * as preferencesCodec from '@noodara/domain/preferences';
import type { Preferences } from '@noodara/domain/preferences';

export interface BuildPreferencesSetCookieOptions {
  /** Mirrors `env.NOODARA_COOKIE_INSECURE`-derived `useSecureCookies` (auth.ts's own precedent):
   *  `true` unless running over plain HTTP in local dev. */
  readonly secure: boolean;
}

/**
 * Builds the `Set-Cookie` header value for the `noodara-prefs` mirror cookie. Never `HttpOnly`,
 * never `Domain=` -- same attribute order as the browser writer (`Path=/; Max-Age=...;
 * SameSite=Lax` then an optional `; Secure`).
 */
export function buildPreferencesSetCookie(
  preferences: Preferences,
  options: BuildPreferencesSetCookieOptions,
): string {
  const secure = options.secure ? '; Secure' : '';
  const value = preferencesCodec.serializePreferencesCookieValue(preferences);
  return `${preferencesCodec.PREFERENCES_COOKIE_NAME}=${value}; Path=/; Max-Age=${String(preferencesCodec.PREFERENCES_COOKIE_MAX_AGE_SECONDS)}; SameSite=Lax${secure}`;
}
