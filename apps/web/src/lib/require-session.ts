// The authenticated shell's own client-side session guard (05-12-PLAN.md Task 2, T-5-53). This is
// UX only -- the real authorization boundary stays entirely on the backend's `requireSession`
// onRequest hook (apps/control-plane/src/auth/require-session.ts, CLAUDE.md SS2.3: "toda
// restriccion de permisos se aplica en backend"). This file never inspects, stores, or attempts to
// refresh a session; the session cookie is HttpOnly by design and stays untouched here.
//
// Reconciled with apps/web/src/proxy.ts (Plan 05-10): proxy.ts is the coarser server-side redirect
// that runs before a protected route renders at all, checked once per navigation via the same
// `GET /api/auth/get-session` shape. This hook is the client-side counterpart for a session that
// goes bad *after* the shell has already mounted. Two callers drive it post-mount (05-35-PLAN.md
// Task 3): the shell layout re-runs it when the shared SSE stream drops after having been open --
// the heartbeat closing the stream server-side on a revoked session is exactly that transition --
// and several screens already re-run it whenever their own fetch surfaces a real 401. Both
// ultimately redirect to the same `/login` destination and both react to the one real 401 the
// backend produces -- neither invents a second, divergent notion of "has a session."
//
// T-5G-35-04 (05-35-PLAN.md): plan 05-28 added a genuine `AbortSignal.timeout` inside
// `api-client.ts`'s own fetch wrapper, so this file no longer races a second, shorter timeout on
// top of it. That old race resolved a hang to `unauthorized: true` -- fail-closed, forcing a
// logout on a slow network. That is no longer the right trade-off now that this file is also
// invoked from a background SSE-drop signal, not just once on mount: a hung/slow `/api/config`
// call during a transient network blip must not force a sign-out, only a real 401 may. Removing
// the extra race means a hang now surfaces (after api-client.ts's own 15s budget) as
// `NETWORK_ERROR`, which never redirects -- consistent with every other post-mount caller of this
// function and with T-5G-35-04's own mitigation.
import { apiGet, type ApiResult } from './api-client';

// T-5G-35-03: a burst of failing requests (the mount check racing a screen's own 401, or the
// SSE-drop signal racing either) must still navigate at most once per page load, never a
// redirect loop or multiple navigations stacking up behind it.
let hasRedirected = false;

function redirectToLogin(): void {
  if (typeof window === 'undefined') return;
  if (hasRedirected) return;
  hasRedirected = true;
  const redirectTo = `${window.location.pathname}${window.location.search}`;
  window.location.assign(`/login?redirect=${encodeURIComponent(redirectTo)}`);
}

/**
 * The shell layout's own guard: performs one lightweight authenticated fetch (`GET /api/config`,
 * already session-protected and cheap) and redirects to `/login` -- carrying the current path so
 * login can send the user back -- the moment the result's `unauthorized` flag is set. Every other
 * outcome (success or a non-401 failure, including `NETWORK_ERROR`) is returned to the caller
 * unchanged and never redirects.
 */
export async function requireSession(): Promise<ApiResult<unknown>> {
  const result = await apiGet('/api/config');

  if (!result.ok && result.unauthorized) {
    redirectToLogin();
  }

  return result;
}
