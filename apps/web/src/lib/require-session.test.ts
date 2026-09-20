// WR-B-10 (05-VERIFICATION.md gap 8 / 05-35-PLAN.md Task 3). This suite runs in Vitest's `apps`
// project (node environment, no `window` global by default -- see safe-storage.test.ts's own
// precedent), so `window` is stubbed per case via `vi.stubGlobal` rather than relying on jsdom.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiResult } from './api-client';

const apiGetMock = vi.fn<(path: string) => Promise<ApiResult<unknown>>>();

vi.mock('./api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api-client')>()),
  apiGet: (path: string) => apiGetMock(path),
}));

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

function stubWindow(pathname: string, search: string): { assign: ReturnType<typeof vi.fn> } {
  const assign = vi.fn();
  vi.stubGlobal('window', { location: { pathname, search, assign } });
  return { assign };
}

beforeEach(() => {
  apiGetMock.mockReset();
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('requireSession', () => {
  it('redirects to /login with the current path+search encoded when GET /api/config answers unauthorized', async () => {
    const { assign } = stubWindow('/servers/srv_1', '?tab=facts');
    apiGetMock.mockResolvedValueOnce(unauthorizedFailure());

    const { requireSession } = await import('./require-session');
    const result = await requireSession();

    expect(result.ok).toBe(false);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(`/login?redirect=${encodeURIComponent('/servers/srv_1?tab=facts')}`);
  });

  it('does not redirect on success', async () => {
    const { assign } = stubWindow('/servers', '');
    apiGetMock.mockResolvedValueOnce({ ok: true, data: {} });

    const { requireSession } = await import('./require-session');
    await requireSession();

    expect(assign).not.toHaveBeenCalled();
  });

  // T-5G-35-04: a transient network blip must never look like a revoked session -- only a real
  // 401 from the backend may navigate the tab away.
  it('does not redirect when the fetch fails with NETWORK_ERROR', async () => {
    const { assign } = stubWindow('/servers', '');
    apiGetMock.mockResolvedValueOnce(networkErrorFailure());

    const { requireSession } = await import('./require-session');
    const result = await requireSession();

    expect(result.ok).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });

  // T-5G-35-03: a burst of failing requests (e.g. the shell's own mount check racing a screen's
  // 401, or two screens surfacing the same revoked session at once) must still navigate exactly
  // once, never a redirect loop or multiple navigations.
  it('redirects at most once even when called multiple times in a row, all unauthorized', async () => {
    const { assign } = stubWindow('/servers', '');
    apiGetMock.mockResolvedValue(unauthorizedFailure());

    const { requireSession } = await import('./require-session');
    await requireSession();
    await requireSession();
    await requireSession();

    expect(assign).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when window is undefined (SSR-safe)', async () => {
    expect(typeof window).toBe('undefined');
    apiGetMock.mockResolvedValueOnce(unauthorizedFailure());

    const { requireSession } = await import('./require-session');

    await expect(requireSession()).resolves.toEqual(unauthorizedFailure());
  });
});
