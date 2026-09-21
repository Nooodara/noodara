import path from 'node:path';
import type { NextConfig } from 'next';

// D-29/T-5-26/T-5-30 (05-07-PLAN.md threat register): apps/web reaches the control plane only
// through this same-origin proxy -- `/api/:path*` is rewritten to NOODARA_API_ORIGIN below, and
// the browser never sees or is allowed to target the control plane's own origin directly. See
// docs/adr/0006-web-app-same-origin-proxy-and-ports.md for the full rationale (cookies, EventSource,
// dev port assignment, Origin-guard interaction).
//
// No fallback literal: the repo's eslint config bans `process.env.X ?? 'literal'` /
// `process.env.X || 'literal'` outright (PITFALLS.md #1), and a missing required env var must fail
// fast with a named error, mirroring apps/control-plane/src/env.ts's own posture -- never a silent
// default that could route API traffic somewhere unintended.
function readApiOrigin(): string {
  const value = process.env.NOODARA_API_ORIGIN;
  if (value === undefined || value.length === 0) {
    throw new Error(
      'NOODARA_API_ORIGIN is required (the control plane origin apps/web proxies /api/* to, ' +
        'e.g. http://localhost:3100 in dev) -- set it before running next dev/build.',
    );
  }
  return value;
}

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // 06-05-PLAN.md Task 1: `output: 'standalone'` is what lets the production image ship a
  // self-contained server with no pnpm and no source tree at runtime (D-01) -- `next build`
  // emits a minimal `.next/standalone` tree with only the node_modules this app actually needs,
  // instead of requiring `pnpm install` + the full workspace inside the published image.
  output: 'standalone',

  // `outputFileTracingRoot` is set explicitly, computed from this file's own location (never
  // `process.cwd()`, matching this repo's file-location-not-cwd resolution convention), because
  // Next.js's auto-detection walks up looking for a lockfile and this monorepo has one at the
  // workspace root -- leaving it implicit would make the emitted `.next/standalone` directory
  // layout depend on which directory `next build` happened to run from (the repo root inside a
  // `turbo prune`d Docker build context vs. `apps/web` directly) rather than on configuration,
  // and apps/web/Dockerfile's `COPY`/`CMD` paths depend on that layout being stable.
  outputFileTracingRoot: path.join(import.meta.dirname, '../../'),

  rewrites() {
    const apiOrigin = readApiOrigin();
    return [
      {
        source: '/api/:path*',
        destination: `${apiOrigin}/api/:path*`,
      },
    ];
  },

  // T-5-28: clickjacking of the admin UI -- new item this phase adds, not covered by any Phase 4
  // control. X-Frame-Options is the legacy/broad-browser-support header; the CSP frame-ancestors
  // directive is the modern equivalent, kept minimal to this one directive since this app has no
  // other CSP posture defined yet.
  //
  // T-5G-30-02: the `no-referrer` policy entry below closes the setup-token-url-hardening todo's
  // item 2 (.planning/todos/pending/2026-09-19-setup-token-url-hardening.md) -- without it,
  // navigating away from `/setup?token=...` (before T-5G-30-01's history.replaceState strips the
  // param, or via any link a future screen might add) could leak the full URL, including the
  // one-time setup token, in an outbound `Referer` header. `no-referrer` (not `same-origin`) since
  // this is the strictest option and this app has no legitimate cross-origin analytics use case.
  headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
    ];
  },
};

export default nextConfig;
