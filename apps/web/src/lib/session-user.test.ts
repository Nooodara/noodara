// 08-08-PLAN.md Task 2 (UI-11, D-05, T-08-22/T-08-25). Runs in Vitest's `apps` project (node
// environment, no DOM) -- same precedent as require-session.test.ts: the one-shot fetch/narrowing
// logic `useSessionUser()` wraps is exported as a plain, DOM-free async function
// (`loadSessionUser`) precisely so it is unit-testable here without a React render. The hook
// itself (a thin useState/useEffect wrapper around this same function) is proven end-to-end by
// Sidebar.test.tsx's jsdom suite -- including the "apiGet rejects, sidebar still renders" case --
// never duplicated here.
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

beforeEach(() => {
  apiGetMock.mockReset();
});

describe('loadSessionUser', () => {
  it('resolves to { name, email } when GET /api/auth/get-session answers a real session', async () => {
    apiGetMock.mockResolvedValueOnce({
      ok: true,
      data: { session: { id: 'sess_1' }, user: { name: 'Ada Lovelace', email: 'ada@noodara.test' } },
    });

    const { loadSessionUser } = await import('./session-user');
    await expect(loadSessionUser()).resolves.toEqual({ name: 'Ada Lovelace', email: 'ada@noodara.test' });

    expect(apiGetMock).toHaveBeenCalledWith('/api/auth/get-session');
  });

  it('resolves to null on a 401 -- a genuinely expired session is requireSession()\'s job, never handled twice', async () => {
    apiGetMock.mockResolvedValueOnce(unauthorizedFailure());

    const { loadSessionUser } = await import('./session-user');
    await expect(loadSessionUser()).resolves.toBeNull();
  });

  // T-08-25: a down/slow control plane must never throw, never redirect, and never invent a
  // second retry loop -- api-client.ts's own 15s AbortSignal.timeout already turns a hang into
  // this same NETWORK_ERROR failure shape.
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
