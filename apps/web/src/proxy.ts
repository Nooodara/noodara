// Plan 05-10's minimal redirect: an unauthenticated visit to any page other than /login or
// /setup lands on /login. This is a UX convenience only, never a security boundary — the real
// authorization enforcement is `requireSession`'s onRequest hook on the control plane
// (apps/control-plane/src/auth/require-session.ts), which answers 401 regardless of what this
// file does (CLAUDE.md SS2.3: "toda restriccion de permisos se aplica en backend"). A cookie's
// mere presence proves nothing, so this checks the real session via the same
// `GET /api/auth/get-session` endpoint the control plane's own tests use
// (tests/integration/auth/login.test.ts), forwarding the incoming `cookie` header — never trusting
// a client-visible cookie name/shape that could change independently of this file.
//
// `proxy.ts` (not `middleware.ts`) is Next.js 16's current file convention for this network-
// boundary hook — `middleware.ts` still works but is deprecated and runs the edge runtime, which
// this project has no reason to opt into.
//
// The full authenticated shell (Plans 05-11/05-12) will replace this with whatever navigation
// structure those plans build; this file only needs to make the plan's own two in-scope
// behaviours true: an unauthenticated /servers visit ends on /login, and /api/* is never touched
// by this redirect (the rewrite proxy must keep working unauthenticated so the control plane's own
// 401 is what a caller sees).
import { NextResponse, type NextRequest } from 'next/server';

const SESSION_LOOKUP_TIMEOUT_MS = 5000;

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const apiOrigin = process.env.NOODARA_API_ORIGIN;
  if (apiOrigin === undefined || apiOrigin.length === 0) {
    throw new Error('proxy.ts: NOODARA_API_ORIGIN is required (docs/adr/0006)');
  }

  const cookie = request.headers.get('cookie');
  let hasSession = false;
  try {
    const response = await fetch(`${apiOrigin}/api/auth/get-session`, {
      headers: cookie === null ? {} : { cookie },
      signal: AbortSignal.timeout(SESSION_LOOKUP_TIMEOUT_MS),
    });
    if (response.ok) {
      const body: unknown = await response.json();
      hasSession =
        body !== null &&
        typeof body === 'object' &&
        'session' in body &&
        (body as { session?: unknown }).session !== null &&
        (body as { session?: unknown }).session !== undefined;
    }
  } catch {
    // A down/slow session lookup must never leave a protected page reachable -- treat it the
    // same as "no session".
    hasSession = false;
  }

  if (!hasSession) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|login|setup).*)'],
};
