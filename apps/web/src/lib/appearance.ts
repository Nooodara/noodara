// The Appearance controller (SET-04/SET-05, 09-CONTEXT.md D-09/D-12/D-13/D-15) -- the single write
// path for all three Appearance `SegmentedControl`s on `/settings`. Every control calls this
// function, never `applyPreferences`/`document.documentElement.setAttribute`/
// `localStorage.setItem` directly (P17, T-09-25): the apply is optimistic so the UI responds
// instantly, the server stays the source of truth (D-09), and a failed `PATCH` reverts both the
// applied preference and the store to the previous value.
import { applyPreferences, readPreferencesMirror } from '@noodara/ui';
import { DEFAULT_PREFERENCES, type Preferences } from '@noodara/domain/preferences';
import { apiSend, type ApiResult } from './api-client';
import { setStoredPreferences } from './session-user';

export type AppearanceKey = 'theme' | 'reduceMotion' | 'density';

export interface UpdateAppearanceDeps {
  readonly apply: (preferences: Preferences) => void;
  readonly setStored: (preferences: Preferences) => void;
  readonly send: <T>(method: 'PATCH', path: string, body?: unknown) => Promise<ApiResult<T>>;
  readonly getCurrent: () => Preferences;
}

export interface UpdateAppearanceResult {
  readonly ok: boolean;
  readonly message?: string;
}

const APPEARANCE_ERROR_MESSAGE = "Couldn't save your appearance settings. Try again.";

/** Reads the mirror cookie (D-09's own client-side cache), falling back to the shared defaults --
 *  never throws, never reads anything but the cookie the browser already trusts. */
function defaultGetCurrent(): Preferences {
  return readPreferencesMirror() ?? DEFAULT_PREFERENCES;
}

const defaultDeps: UpdateAppearanceDeps = {
  apply: applyPreferences,
  setStored: setStoredPreferences,
  send: apiSend,
  getCurrent: defaultGetCurrent,
};

/**
 * updateAppearancePreference -- applies `{ [key]: value }` on top of the current preferences
 * optimistically (`deps.apply` + `deps.setStored`, in that order, before the request), then sends
 * the single-field `PATCH /api/account/preferences`. On success, `deps.setStored` is called again
 * with the server's own response body (the source of truth, D-09/D-10). On failure, both the
 * applied preference and the store revert to the previous value and a fixed, product-voice message
 * is returned -- never a raw server message.
 */
export async function updateAppearancePreference<K extends AppearanceKey>(
  key: K,
  value: Preferences[K],
  deps: Partial<UpdateAppearanceDeps> = {},
): Promise<UpdateAppearanceResult> {
  const resolved: UpdateAppearanceDeps = { ...defaultDeps, ...deps };

  const previous = resolved.getCurrent();
  const next: Preferences = { ...previous, [key]: value };

  resolved.apply(next);
  resolved.setStored(next);

  const result = await resolved.send<Preferences>('PATCH', '/api/account/preferences', { [key]: value });

  if (!result.ok) {
    resolved.apply(previous);
    resolved.setStored(previous);
    return { ok: false, message: APPEARANCE_ERROR_MESSAGE };
  }

  resolved.setStored(result.data);
  return { ok: true };
}
