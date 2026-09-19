// A dedicated streaming proxy for `GET /api/events`, discovered necessary by this plan's own
// security review: `next.config.ts`'s generic `rewrites()`-based `/api/:path*` proxy buffers a
// long-lived, never-ending SSE response instead of streaming it through -- confirmed empirically
// (a real `server.updated` frame published while the stream was open through the rewrite never
// reached the browser even after 8s, while the identical request against the control plane
// directly, or a plain fetch to a fake origin bypassing the rewrite, streamed every chunk within
// milliseconds of being written). This is a known limitation of Next.js's `rewrites()` config for
// this exact shape of response (a chunked body with no defined end), not a bug in
// `apps/control-plane/src/routes/events.ts`.
//
// Next.js Route Handlers, unlike `rewrites()`, support returning a live `ReadableStream` response
// body -- this route manually forwards the request to the control plane and pipes the upstream
// response straight through, unbuffered. A literal Route Handler at this exact path is resolved
// by Next's filesystem router *before* the generic `rewrites()` array is ever consulted for the
// same path (Next.js checks filesystem routes, including Route Handlers, ahead of a plain
// rewrites() array per its own routing precedence), so every other `/api/*` path keeps using
// `next.config.ts`'s existing proxy unchanged -- this file only ever intercepts `/api/events`.
import type { NextRequest } from 'next/server';

// Disables static optimization/caching for this route -- every request is a fresh, live proxy
// call, never a cached response (this handler's whole purpose is a live stream).
export const dynamic = 'force-dynamic';

function readApiOrigin(): string {
  const value = process.env.NOODARA_API_ORIGIN;
  if (value === undefined || value.length === 0) {
    throw new Error(
      'NOODARA_API_ORIGIN is required (apps/web/src/app/api/events/route.ts streams /api/events ' +
        'from it, matching next.config.ts docs/adr/0006-web-app-same-origin-proxy-and-ports.md)',
    );
  }
  return value;
}

export async function GET(request: NextRequest): Promise<Response> {
  const apiOrigin = readApiOrigin();
  // Same discipline as apps/web/src/proxy.ts: forward only the cookie header, never invent an
  // identifying header the browser did not itself send, and never inspect or store the cookie's
  // value -- the control plane's own requireSession hook is the real authorization boundary.
  const cookie = request.headers.get('cookie');

  const upstream = await fetch(`${apiOrigin}/api/events`, {
    headers: cookie === null ? {} : { cookie },
  });

  const headers = new Headers();
  headers.set('Content-Type', upstream.headers.get('content-type') ?? 'text/event-stream');
  headers.set('Cache-Control', 'no-cache');
  headers.set('Connection', 'keep-alive');
  headers.set('X-Accel-Buffering', 'no');
  // D-07/T-5-54: forwarded unchanged so the pre-open SSE_LIMIT_REACHED (503) case's Retry-After
  // still reaches use-server-events.ts's own backoff logic.
  const retryAfter = upstream.headers.get('retry-after');
  if (retryAfter !== null) {
    headers.set('Retry-After', retryAfter);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}
