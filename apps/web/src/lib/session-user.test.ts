// @vitest-environment jsdom
//
// 09-10-PLAN.md Task 2 (D-04, D-10, D-16). This file's own `apps` Vitest project defaults to the
// node environment (no DOM) -- the per-file `@vitest-environment` pragma above opts this one file
// into jsdom instead, the minimum needed for `@testing-library/react`'s `renderHook` to exercise
// `useSessionUser`/`useAccountPreferences` (both thin `useSyncExternalStore` wrappers around the
// shared store) directly, without a full component tree. Both `apiGet` and `@noodara/ui`'s
// `applyPreferences`/`readPreferencesMirror` are mocked at the module boundary regardless, so no
// test here ever touches a real fetch or a real cookie/localStorage read. `loadSessionUser`'s own
// DOM-free describe block below is unaffected by the environment switch.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Preferences } from '@noodara/domain/preferences';
import type { ApiResult } from './api-client';

const apiGetMock = vi.fn<(path: string) => Promise<ApiResult<unknown>>>();
const applyPreferencesMock = vi.fn<(preferences: Preferences) => void>();
const readPreferencesMirrorMock = vi.fn<() => Preferences | null>();

vi.mock('./api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api-client')>()),
  apiGet: (path: string) => apiGetMock(path),
}));

vi.mock('@noodara/ui', () => ({
  applyPreferences: (preferences: Preferences) => {
    applyPreferencesMock(preferences);
  },
  readPreferencesMirror: () => readPreferencesMirrorMock(),
}));

function sessionSuccess(name: string, email: string): ApiResult<unknown> {
  return { ok: true, data: { session: { id: 'sess_1' }, user: { name, email } } };
}

function preferencesSuccess(preferences: Preferences): ApiResult<unknown> {
  return { ok: true, data: preferences };
}

function unauthorizedFailure(): ApiResult<unknown> {
  return { ok: false, code: 'UNAUTHORIZED', message: 'Your session ended. Sign in again.', unauthorized: true };
}

function networkErrorFailure(): ApiResult<unknown> {
  return {
    ok: false,
    code: 'NETWORK_ERROR',
    message: 'Could not reach the server. Check your connection and try again.',
    unauthorized: false,
  };
}

const AUTO_PREFERENCES: Preferences = { theme: 'auto', reduceMotion: 'system', density: 'comfortable' };
const DARK_PREFERENCES: Preferences = { theme: 'dark', reduceMotion: 'on', density: 'compact' };

function mockRoutes(handlers: {
  session?: () => Promise<ApiResult<unknown>>;
  preferences?: () => Promise<ApiResult<unknown>>;
}): void {
  apiGetMock.mockImplementation((path: string) => {
    if (path === '/api/auth/get-session') {
      return (handlers.session ?? (() => Promise.resolve(sessionSuccess('Ada Lovelace', 'ada@noodara.test'))))();
    }
    if (path === '/api/account/preferences') {
      return (handlers.preferences ?? (() => Promise.resolve(preferencesSuccess(AUTO_PREFERENCES))))();
    }
    throw new Error(`session-user.test.ts: unexpected apiGet path "${path}"`);
  });
}

beforeEach(() => {
  apiGetMock.mockReset();
  applyPreferencesMock.mockReset();
  readPreferencesMirrorMock.mockReset();
  readPreferencesMirrorMock.mockReturnValue(null);
});

describe('loadSessionUser', () => {
  it('resolves to { name, email } when GET /api/auth/get-session answers a real session', async () => {
    mockRoutes({});

    const { loadSessionUser } = await import('./session-user');
    await expect(loadSessionUser()).resolves.toEqual({ name: 'Ada Lovelace', email: 'ada@noodara.test' });

    expect(apiGetMock).toHaveBeenCalledWith('/api/auth/get-session');
  });

  it('resolves to null on a 401 -- a genuinely expired session is requireSession()\'s job, never handled twice', async () => {
    apiGetMock.mockResolvedValueOnce(unauthorizedFailure());

    const { loadSessionUser } = await import('./session-user');
    await expect(loadSessionUser()).resolves.toBeNull();
  });

  it('resolves to null, never throws, on a NETWORK_ERROR (covers both a down server and a timed-out fetch)', async () => {
    apiGetMock.mockResolvedValueOnce(networkErrorFailure());

    const { loadSessionUser } = await import('./session-user');
    await expect(loadSessionUser()).resolves.toBeNull();
  });

  it('resolves to null on a malformed success body -- never a cast, never a partial user reaching the caller', async () => {
    apiGetMock.mockResolvedValueOnce({ ok: true, data: { user: { name: 'Ada Lovelace' } } });

    const { loadSessionUser } = await import('./session-user');
    await expect(loadSessionUser()).resolves.toBeNull();
  });

  it('resolves to null when the response carries no session at all', async () => {
    apiGetMock.mockResolvedValueOnce({ ok: true, data: { session: null, user: null } });

    const { loadSessionUser } = await import('./session-user');
    await expect(loadSessionUser()).resolves.toBeNull();

    apiGetMock.mockResolvedValueOnce({ ok: true, data: {} });
    await expect(loadSessionUser()).resolves.toBeNull();
  });

  it('T-08-22: never spreads the raw session/user object -- only name and email ever reach the caller', async () => {
    apiGetMock.mockResolvedValueOnce({
      ok: true,
      data: {
        session: { id: 'sess_1', token: 'super-secret-session-token' },
        user: {
          id: 'usr_1',
          name: 'Ada Lovelace',
          email: 'ada@noodara.test',
          passwordHash: 'never-should-reach-the-caller',
        },
      },
    });

    const { loadSessionUser } = await import('./session-user');
    const result = await loadSessionUser();

    expect(result).toEqual({ name: 'Ada Lovelace', email: 'ada@noodara.test' });
    expect(Object.keys(result ?? {}).sort()).toEqual(['email', 'name']);
  });
});

// D-04/D-10/D-16: the shared store two subscribers (AccountMenu, Settings) read from.
describe('session-user shared store', () => {
  it('feeds two subscribers of useSessionUser the same { name, email } from a single get-session fetch', async () => {
    let sessionCalls = 0;
    mockRoutes({
      session: () => {
        sessionCalls += 1;
        return Promise.resolve(sessionSuccess('Ada Lovelace', 'ada@noodara.test'));
      },
    });

    const { useSessionUser } = await import('./session-user');
    const { renderHook, waitFor } = await import('@testing-library/react');

    const first = renderHook(() => useSessionUser());
    const second = renderHook(() => useSessionUser());

    await waitFor(() => {
      expect(first.result.current).toEqual({ name: 'Ada Lovelace', email: 'ada@noodara.test' });
    });
    expect(second.result.current).toEqual({ name: 'Ada Lovelace', email: 'ada@noodara.test' });
    expect(sessionCalls).toBe(1);
  });

  it('refreshSessionUser() re-fetches get-session and every subscriber sees the new name/email (D-04)', async () => {
    mockRoutes({ session: () => Promise.resolve(sessionSuccess('Ada Lovelace', 'ada@noodara.test')) });

    const { useSessionUser, refreshSessionUser } = await import('./session-user');
    const { renderHook, waitFor, act } = await import('@testing-library/react');

    const hook = renderHook(() => useSessionUser());
    await waitFor(() => {
      expect(hook.result.current).toEqual({ name: 'Ada Lovelace', email: 'ada@noodara.test' });
    });

    mockRoutes({ session: () => Promise.resolve(sessionSuccess('Ada Lovelace-Renamed', 'ada@noodara.test')) });
    await act(async () => {
      await refreshSessionUser();
    });

    expect(hook.result.current).toEqual({ name: 'Ada Lovelace-Renamed', email: 'ada@noodara.test' });
  });

  it('loads /api/account/preferences alongside get-session; useAccountPreferences parses it via PreferencesSchema', async () => {
    mockRoutes({ preferences: () => Promise.resolve(preferencesSuccess(DARK_PREFERENCES)) });

    const { useAccountPreferences } = await import('./session-user');
    const { renderHook, waitFor } = await import('@testing-library/react');

    const hook = renderHook(() => useAccountPreferences());
    await waitFor(() => {
      expect(hook.result.current).toEqual(DARK_PREFERENCES);
    });
  });

  it('useAccountPreferences resolves to null on an invalid preferences body', async () => {
    mockRoutes({ preferences: () => Promise.resolve({ ok: true, data: { theme: 'not-a-real-theme' } }) });

    const { useAccountPreferences } = await import('./session-user');
    const { renderHook, waitFor } = await import('@testing-library/react');

    const hook = renderHook(() => useAccountPreferences());
    await waitFor(() => {
      expect(apiGetMock).toHaveBeenCalledWith('/api/account/preferences');
    });
    expect(hook.result.current).toBeNull();
  });

  it('applies the server preferences (D-10) exactly once when they differ from the mirror, including a null mirror', async () => {
    readPreferencesMirrorMock.mockReturnValue(null);
    mockRoutes({ preferences: () => Promise.resolve(preferencesSuccess(DARK_PREFERENCES)) });

    const { useAccountPreferences } = await import('./session-user');
    const { renderHook, waitFor } = await import('@testing-library/react');

    renderHook(() => useAccountPreferences());

    await waitFor(() => {
      expect(applyPreferencesMock).toHaveBeenCalledTimes(1);
    });
    expect(applyPreferencesMock).toHaveBeenCalledWith(DARK_PREFERENCES);
  });

  it('never calls applyPreferences when the server value equals the mirror', async () => {
    readPreferencesMirrorMock.mockReturnValue(AUTO_PREFERENCES);
    mockRoutes({ preferences: () => Promise.resolve(preferencesSuccess(AUTO_PREFERENCES)) });

    const { useAccountPreferences } = await import('./session-user');
    const { renderHook, waitFor } = await import('@testing-library/react');

    const hook = renderHook(() => useAccountPreferences());

    await waitFor(() => {
      expect(hook.result.current).toEqual(AUTO_PREFERENCES);
    });
    expect(applyPreferencesMock).not.toHaveBeenCalled();
  });

  // 09-13-PLAN.md Task 2 (Rule 1 bug, found by the real cross-browser theme-sync E2E case):
  // `GET /api/account/preferences` itself re-issues the `noodara-prefs` Set-Cookie header on every
  // call (`buildPreferencesSetCookie`, apps/control-plane/src/routes/account.ts), and a browser
  // applies a fetch response's Set-Cookie before the response promise settles -- so reading the
  // mirror *after* this request resolves always sees the value this very request just wrote. The
  // mirror must be captured before the request fires, or a brand-new session (mirror genuinely
  // null beforehand) would see a manufactured "already agrees" match and skip `applyPreferences`
  // entirely, leaving whatever `data-theme` happened to be painted before login uncorrected.
  it('still applies the server preferences when the mirror only starts agreeing because this same request set it (T-09-13)', async () => {
    readPreferencesMirrorMock.mockReturnValue(null);
    mockRoutes({
      preferences: () => {
        // Simulates the real browser applying this response's own Set-Cookie header before the
        // fetch promise resolves -- readPreferencesMirror() would now see the just-written value.
        readPreferencesMirrorMock.mockReturnValue(DARK_PREFERENCES);
        return Promise.resolve(preferencesSuccess(DARK_PREFERENCES));
      },
    });

    const { useAccountPreferences } = await import('./session-user');
    const { renderHook, waitFor } = await import('@testing-library/react');

    renderHook(() => useAccountPreferences());

    await waitFor(() => {
      expect(applyPreferencesMock).toHaveBeenCalledTimes(1);
    });
    expect(applyPreferencesMock).toHaveBeenCalledWith(DARK_PREFERENCES);
  });

  it('setStoredPreferences updates subscribers without any network call', async () => {
    mockRoutes({ preferences: () => Promise.resolve(preferencesSuccess(AUTO_PREFERENCES)) });

    const { useAccountPreferences, setStoredPreferences } = await import('./session-user');
    const { renderHook, waitFor, act } = await import('@testing-library/react');

    const hook = renderHook(() => useAccountPreferences());
    await waitFor(() => {
      expect(hook.result.current).toEqual(AUTO_PREFERENCES);
    });

    const preFetchCalls = apiGetMock.mock.calls.length;
    act(() => {
      setStoredPreferences(DARK_PREFERENCES);
    });

    expect(hook.result.current).toEqual(DARK_PREFERENCES);
    expect(apiGetMock.mock.calls.length).toBe(preFetchCalls);
  });

  it('a failed fetch leaves user/preferences null and never throws', async () => {
    mockRoutes({
      session: () => Promise.resolve(networkErrorFailure()),
      preferences: () => Promise.resolve(networkErrorFailure()),
    });

    const { useSessionUser, useAccountPreferences } = await import('./session-user');
    const { renderHook, waitFor } = await import('@testing-library/react');

    const userHook = renderHook(() => useSessionUser());
    const prefsHook = renderHook(() => useAccountPreferences());

    await waitFor(() => {
      expect(apiGetMock).toHaveBeenCalledWith('/api/auth/get-session');
    });
    expect(userHook.result.current).toBeNull();
    expect(prefsHook.result.current).toBeNull();
  });
});
