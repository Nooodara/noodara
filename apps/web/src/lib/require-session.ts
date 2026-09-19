// The authenticated shell's own client-side session guard (05-12-PLAN.md Task 2, T-5-53). This is
// UX only -- the real authorization boundary stays entirely on the backend's `requireSession`
// onRequest hook (apps/control-plane/src/auth/require-session.ts, CLAUDE.md SS2.3: "toda
// restriccion de permisos se aplica en backend"). This file never inspects, stores, or attempts to
// refresh a session; the session cookie is HttpOnly by design and stays untouched here.
//
// Reconciled with apps/web/src/proxy.ts (Plan 05-10): proxy.ts is the coarser server-side redirect
// that runs before a protected route renders at all, checked once per navigation via the same
// `GET /api/auth/get-session` shape. This hook is the client-side counterpart for a session that
// goes bad *after* the shell has already mounted -- the SSE heartbeat closing the stream
// server-side, a sign-out from another tab, a session expiring while this tab stays open. Both
// ultimately redirect to the same `/login` destination and both react to the one real 401 the
// backend produces -- neither invents a second, divergent notion of "has a session."
import { apiGet, type ApiResult } from './api-client';

const REQUIRE_SESSION_TIMEOUT_MS = 5000;

function redirectToLogin(): void {
  if (typeof window === 'undefined') return;
  const redirectTo = `${window.location.pathname}${window.location.search}`;
  window.location.assign(`/login?redirect=${encodeURIComponent(redirectTo)}`);
}

function timedOutFailure(): ApiResult<unknown> {
  return {
    ok: false,
    code: 'UNAUTHORIZED',
    message: 'Your session ended. Sign in again.',
    unauthorized: true,
  };
}

/** Races `perform()` against an explicit timeout so a hung request can never leave a protected
 *  screen looking reachable -- a timeout fails closed exactly like a real 401, never like a
 *  success. `perform`'s own promise is left to settle in the background (fetch has no generic
 *  caller-agnostic cancellation seam here); only the wait is bounded. */
function withTimeout<T>(perform: () => Promise<ApiResult<T>>, timeoutMs: number): Promise<ApiResult<T>> {
  return Promise.race([
    perform(),
    new Promise<ApiResult<T>>((resolve) => {
      setTimeout(() => {
        resolve(timedOutFailure() as ApiResult<T>);
      }, timeoutMs);
    }),
  ]);
}

/**
 * The shell layout's own guard, run once on mount: performs one lightweight authenticated fetch
 * (`GET /api/config`, already session-protected and cheap) and redirects to `/login` -- carrying
 * the current path so login can send the user back -- the moment the result's `unauthorized` flag
 * is set. Every other outcome (success or a non-401 failure) is returned to the caller unchanged.
 */
export async function requireSession(): Promise<ApiResult<unknown>> {
  const result = await withTimeout(() => apiGet('/api/config'), REQUIRE_SESSION_TIMEOUT_MS);

  if (!result.ok && result.unauthorized) {
    redirectToLogin();
  }

  return result;
}
