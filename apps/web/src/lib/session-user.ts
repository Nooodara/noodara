'use client';

// The shell's shared identity + preferences store (UI-11, D-04, D-10, D-16, 08-08-PLAN.md Task 2,
// 09-10-PLAN.md Task 2). A single module-level store, not a per-mount fetch: `AccountMenu` in
// `Sidebar.tsx` and Settings' own screens (09-11/09-12) both subscribe to the same snapshot, and
// `refreshSessionUser()` lets a caller (the profile-edit Sheet) force a re-fetch after a save so
// every subscriber re-renders with the new name/email without a page reload (D-04) -- no second,
// divergent session-lookup shape from `loadSessionUser`, which this file keeps exporting unchanged
// for its own existing unit coverage.
//
// T-08-22/T-09-29: the narrowing below reads exactly `user.name`/`user.email` (session-user) and
// the four fixed `Preferences` fields (preferences-user) and never spreads the raw session/user/
// preferences object into the store -- no token, id or session metadata can ever reach a caller
// (and, downstream, the rendered AccountMenu header or Settings screen) through this file.
//
// D-10: once `/api/account/preferences` resolves, if the server's value differs from the
// `noodara-prefs` mirror cookie (`readPreferencesMirror`, packages/ui/src/ThemeToggle.tsx),
// `applyPreferences(server)` runs immediately -- the server wins over whatever the mirror cached
// from a previous browser/session. `applyPreferences` is the single browser write path (P17); this
// file only ever calls it, never writes the cookie/localStorage/attributes itself.
import { useCallback, useSyncExternalStore } from 'react';
import { applyPreferences, readPreferencesMirror } from '@noodara/ui';
import { PreferencesSchema, type Preferences } from '@noodara/domain/preferences';
import { apiGet } from './api-client';

export interface SessionUser {
  readonly name: string;
  readonly email: string;
}

interface RawSessionUser {
  readonly name?: unknown;
  readonly email?: unknown;
}

interface RawGetSessionResponse {
  readonly user?: unknown;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function narrowSessionUser(data: unknown): SessionUser | null {
  if (typeof data !== 'object' || data === null) return null;
  const user = (data as RawGetSessionResponse).user;
  if (typeof user !== 'object' || user === null) return null;
  const { name, email } = user as RawSessionUser;
  if (!isNonEmptyString(name) || !isNonEmptyString(email)) return null;
  return { name, email };
}

/** The DOM-free fetch+narrow step -- unit-tested directly in session-user.test.ts (Vitest's
 *  `apps` node project, no React render needed). Kept exported unchanged: it is the one function
 *  this file's own existing coverage exercises directly, and `ensureLoaded` below reuses it rather
 *  than duplicating the get-session fetch/narrow logic. */
export async function loadSessionUser(): Promise<SessionUser | null> {
  const result = await apiGet<unknown>('/api/auth/get-session');
  if (!result.ok) return null;
  return narrowSessionUser(result.data);
}

async function loadAccountPreferences(): Promise<Preferences | null> {
  const result = await apiGet<unknown>('/api/account/preferences');
  if (!result.ok) return null;
  const parsed = PreferencesSchema.safeParse(result.data);
  return parsed.success ? parsed.data : null;
}

function preferencesEqual(a: Preferences, b: Preferences): boolean {
  return a.theme === b.theme && a.reduceMotion === b.reduceMotion && a.density === b.density;
}

interface AccountSnapshot {
  readonly user: SessionUser | null;
  readonly preferences: Preferences | null;
}

let snapshot: AccountSnapshot = { user: null, preferences: null };
const listeners = new Set<() => void>();
let loadPromise: Promise<void> | null = null;

function emit(next: AccountSnapshot): void {
  snapshot = next;
  for (const listener of listeners) {
    listener();
  }
}

function getSnapshot(): AccountSnapshot {
  return snapshot;
}

function getServerSnapshot(): AccountSnapshot {
  return { user: null, preferences: null };
}

/**
 * Loads `/api/auth/get-session` and `/api/account/preferences` in parallel and reconciles the
 * store from the result. Concurrent calls (two subscribers mounting around the same time) share
 * one in-flight promise -- `loadPromise` is cleared once it settles, so a later call (e.g. a fresh
 * mount after every previous subscriber unmounted) always starts a genuinely new load rather than
 * replaying a stale one forever.
 */
function ensureLoaded(): void {
  if (loadPromise !== null) return;

  // T-09-13 (Rule 1 fix, found by 09-13's cross-browser theme-sync E2E): the mirror must be read
  // *before* the `GET /api/account/preferences` request below, not after it resolves.
  // `buildPreferencesSetCookie` (apps/control-plane/src/routes/account.ts) re-issues the
  // `noodara-prefs` Set-Cookie header on every GET, not just PATCH -- browsers apply a fetch
  // response's Set-Cookie header before the response promise settles, so reading the mirror after
  // `loadAccountPreferences()` resolves always sees the value this very request just wrote,
  // making it trivially equal to `preferences` and silently skipping `applyPreferences` even on a
  // brand-new session that has never actually painted the account's real theme (e.g. logging in
  // as a second browser after the account's theme changed elsewhere).
  const mirrorBeforeLoad = readPreferencesMirror();

  loadPromise = Promise.all([loadSessionUser(), loadAccountPreferences()])
    .then(([user, preferences]) => {
      if (preferences !== null) {
        if (mirrorBeforeLoad === null || !preferencesEqual(mirrorBeforeLoad, preferences)) {
          applyPreferences(preferences);
        }
      }
      emit({ user, preferences });
    })
    .catch(() => {
      // Never throws outward -- a down/slow control plane degrades to "no identity yet", exactly
      // like a session that has genuinely expired (already handled by requireSession()'s guard,
      // never a second time here).
      emit({ user: null, preferences: null });
    })
    .finally(() => {
      loadPromise = null;
    });
}

/** Forces a fresh `/api/auth/get-session` read (D-04) -- called after a successful profile/email/
 *  password save so every subscriber (the sidebar's `AccountMenu`, Settings) re-renders with the
 *  new name/email without a page reload. Preferences are left untouched here; a preferences save
 *  updates the store through `setStoredPreferences` instead, with no extra network call. */
export async function refreshSessionUser(): Promise<void> {
  const user = await loadSessionUser();
  emit({ user, preferences: snapshot.preferences });
}

/** Updates the preferences subscribers see, with no network call -- the caller (a Settings
 *  `SegmentedControl`) already has the server's response body from its own successful
 *  `PATCH /api/account/preferences`. */
export function setStoredPreferences(preferences: Preferences): void {
  emit({ user: snapshot.user, preferences });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  ensureLoaded();
  return () => {
    listeners.delete(listener);
  };
}

/**
 * `{ name, email }` once the shared store has loaded, `null` before it resolves or if it fails --
 * see `loadSessionUser` above. Never retries on its own beyond the one shared load; never redirects;
 * never blanks the caller's own render (a failed fetch here must never make the sidebar unusable,
 * only degrade its account trigger to a nameless avatar).
 */
export function useSessionUser(): SessionUser | null {
  const getUserSnapshot = useCallback(() => getSnapshot().user, []);
  const getServerUserSnapshot = useCallback(() => getServerSnapshot().user, []);
  return useSyncExternalStore(subscribe, getUserSnapshot, getServerUserSnapshot);
}

/** The parsed `Preferences` once the shared store has loaded (via `PreferencesSchema.safeParse`),
 *  `null` before it resolves, on a failed fetch, or when the server body does not parse. Settings'
 *  Appearance `SegmentedControl`s (09-12) read the live value from here, the same store
 *  `useSessionUser` reads from -- one shared load, two independent slices. */
export function useAccountPreferences(): Preferences | null {
  const getPreferencesSnapshot = useCallback(() => getSnapshot().preferences, []);
  const getServerPreferencesSnapshot = useCallback(() => getServerSnapshot().preferences, []);
  return useSyncExternalStore(subscribe, getPreferencesSnapshot, getServerPreferencesSnapshot);
}
