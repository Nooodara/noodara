'use client';

// The shell's client-side identity source for AccountMenu (UI-11, D-05, 08-08-PLAN.md Task 2).
// `loadSessionUser` is the one `apiGet` this file ever makes, against the exact same
// `GET /api/auth/get-session` path proxy.ts's own server-side redirect already uses -- never a
// second, divergent session-lookup shape. It never throws: a non-ok result (a real 401, or
// api-client.ts's own 15s AbortSignal.timeout turning a hang into NETWORK_ERROR, T-08-25) and a
// malformed/absent body both resolve to `null`, exactly like a session that has genuinely
// expired -- already handled by the shell's own requireSession() guard, never a second time here.
//
// T-08-22: the narrowing below reads exactly `user.name`/`user.email` and never spreads the raw
// session/user object into the return value -- no token, id or session metadata can ever reach a
// caller (and, downstream, the rendered AccountMenu header) through this file.
import { useEffect, useState } from 'react';
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
 *  `apps` node project, no React render needed). `useSessionUser` below is a thin hook wrapper
 *  around this same function, proven end-to-end by Sidebar.test.tsx's jsdom suite instead. */
export async function loadSessionUser(): Promise<SessionUser | null> {
  const result = await apiGet<unknown>('/api/auth/get-session');
  if (!result.ok) return null;
  return narrowSessionUser(result.data);
}

/**
 * `{ name, email }` once the one-shot mount fetch resolves, `null` before it resolves or if it
 * fails -- see `loadSessionUser` above. Runs exactly once per mount; never retries, never
 * redirects, never blanks the caller's own render (a failed fetch here must never make the
 * sidebar unusable, only degrade its account trigger to a nameless avatar).
 */
export function useSessionUser(): SessionUser | null {
  const [user, setUser] = useState<SessionUser | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadSessionUser()
      .then((result) => {
        if (!cancelled) setUser(result);
      })
      .catch(() => {
        // loadSessionUser never rejects in practice (api-client.ts's own performRequest catches
        // every fetch failure into an ApiFailure) -- this catch exists only so a future change to
        // that contract degrades to the same "no identity yet" state instead of an unhandled
        // rejection reaching the console.
        if (!cancelled) setUser(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return user;
}
