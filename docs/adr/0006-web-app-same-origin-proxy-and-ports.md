# ADR 0006: apps/web reaches the control plane through a same-origin rewrite proxy

## Status

Accepted — 2026-09-19

## Context

05-CONTEXT.md locks `apps/web` (Next.js 16 App Router) as a thin client that never talks to
Postgres or Redis directly and always reaches `apps/control-plane`'s HTTP API. Two existing
control-plane invariants shape how that reach must work:

- `apps/control-plane/src/auth/origin-guard.ts` (D-29/T-4-07) rejects any mutating request whose
  `Origin` header does not strictly equal `NOODARA_PUBLIC_URL`'s origin. The control plane never
  registers a CORS plugin — there is no cross-origin allowlist to widen.
- Session cookies are `HttpOnly; SameSite=Lax` (noodara-security skill SS5) and the SSE stream
  (`GET /api/events`) is consumed via the browser's native `EventSource`, which sends cookies
  automatically only for same-origin (or explicitly `withCredentials`-configured cross-origin)
  requests and cannot set custom headers at all.

A cross-origin `apps/web` → `apps/control-plane` topology would need CORS opened specifically for
the web origin, `EventSource`'s `withCredentials` flag threaded through, and would still leave the
Origin guard comparing against whichever origin is configured as "public" — two origins in play
instead of one, with no reduction in actual trust boundary.

## Decision

`apps/web` never fetches the control plane's own origin directly. `apps/web/next.config.ts`
declares a single `rewrites()` rule:

```ts
async rewrites() {
  return [{ source: '/api/:path*', destination: `${NOODARA_API_ORIGIN}/api/:path*` }];
}
```

Every screen calls the control plane through `apps/web/src/lib/api-client.ts`'s `apiGet`/`apiSend`,
which assert a request path starts with `/api/` and throw before any `fetch()` if it does not — no
call site can construct an absolute cross-origin URL, intentionally or by copy-paste mistake.

Consequences of this shape:

- **Cookies work with zero configuration.** The browser only ever talks to `apps/web`'s own origin;
  `apps/web`'s Next.js server (not the browser) makes the actual request to `NOODARA_API_ORIGIN`
  and forwards the response, including `Set-Cookie`, back through the same origin. `SameSite=Lax` is
  satisfied trivially because there is only one origin from the browser's perspective.
- **`EventSource` needs no configuration.** `GET /api/events` proxies the same way; no
  `withCredentials`, no CORS preflight, no custom header threading.
- **The Origin guard's assumption holds with a one-line dev-port note, not a code change.** In
  development, `NOODARA_PUBLIC_URL` (what the guard compares an incoming `Origin` header against)
  must be set to the **web** app's origin (`http://localhost:3000`), not the control plane's own
  dev `PORT` (`3100`) — because from the browser's perspective, every mutating request's `Origin`
  header names `apps/web`'s origin, never the control plane's. `.env.example` documents this
  explicitly, naming the `FORBIDDEN_ORIGIN` failure mode a mixed-up pair produces.
- **Production (phase 6) collapses to one origin entirely.** The installer places `apps/web` and
  `apps/control-plane` behind one reverse-proxied public origin, at which point `NOODARA_API_ORIGIN`
  simply points at the control plane's internal address and `NOODARA_PUBLIC_URL` is that one public
  origin — the same relative-URL client code in `api-client.ts` runs unchanged; nothing about this
  proxy shape is dev-only.
- **Clickjacking gets a first control this phase.** `next.config.ts`'s `headers()` sends
  `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'` on every route — a
  new item 05-RESEARCH.md's Security Domain flagged as uncovered by any Phase 4 control, since this
  is the first phase with a browser-rendered admin surface at all.

## Rejected alternatives

- **CORS with an explicit allowlist for the web origin.** Solves nothing this proxy doesn't already
  solve, adds a second origin to reason about in the Origin guard and in `EventSource`'s
  `withCredentials` configuration, and reopens exactly the class of misconfiguration (an
  over-broad `Access-Control-Allow-Origin`) the roadmap's "seguridad por defecto" principle exists
  to avoid.
- **A client-side `fetch` straight to `NOODARA_API_ORIGIN`.** Requires `credentials: 'include'`
  plus CORS plus `EventSource` cross-origin credentials — three new cross-origin surfaces for zero
  functional gain over a same-origin rewrite, and `api-client.ts`'s absolute-URL-throws guard
  (T-5-26) would have nothing to enforce against.

## Consequences

- `apps/web/next.config.ts` fails fast (throws, naming the variable) if `NOODARA_API_ORIGIN` is
  unset — mirrors `apps/control-plane/src/env.ts`'s fail-fast posture (INST-06) rather than
  silently defaulting to a guessed origin.
- `turbo.json`'s `dev` task's `passThroughEnv` and the `build` task's `env` both declare
  `NOODARA_API_ORIGIN`, or Turborepo's strict env mode silently strips it before spawning
  `next dev`/`next build` (the same class of defect ADR 0003 already documents for
  `apps/control-plane`'s own env vars).
- `.env.example` documents both `NOODARA_API_ORIGIN` and the `NOODARA_PUBLIC_URL` dev-port pairing
  above, naming `FORBIDDEN_ORIGIN` explicitly so a future contributor who mixes up the two ports
  has a direct line from the 403 back to this note.
