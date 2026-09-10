# ADR 0001: Fastify Zod type provider — `@fastify/type-provider-zod`

## Status

Accepted — 2026-09-10

## Context

`01-RESEARCH.md` (Open Question 3, Assumption A1) left one packaging question
open: whether to pin the newer, officially-scoped `@fastify/type-provider-zod`
(v1.0.0, published under the `fastify` GitHub org) or the older, unscoped
`fastify-type-provider-zod` (v7.0.0, maintained by `turkerdev`). Both packages
were already confirmed legitimate in `docs/adr/0000-package-legitimacy-approvals.md`
(registry `repository.url` resolves to the expected GitHub `owner/repo` for
both). The 6-major-version gap between a "v1" and a "v7" package solving the
same problem is unusual for a straightforward "the official org took over"
story, so Assumption A1 required reading both packages' current README/
CHANGELOG before locking, rather than assuming continuity.

## Evidence Consulted

- Context7 `/fastify/fastify-type-provider-zod` — README setup example
  (`validatorCompiler`/`serializerCompiler`/`withTypeProvider<ZodTypeProvider>()`)
  and the compatibility note "requires Zod version 4.2 or later."
- Context7 `/turkerdev/fastify-type-provider-zod` — README setup example
  (identical exported surface: `ZodTypeProvider`, `validatorCompiler`,
  `serializerCompiler`, same `withTypeProvider<ZodTypeProvider>()` call
  pattern) and its v7 compatibility table (`>=7.x` requires zod `4.2+`,
  `>=5.x <7.x` requires zod `4.x`).
- `npm view @fastify/type-provider-zod versions description repository.url time.created`:
  single published version `1.0.0`, description `"Zod Type Provider for
  Fastify@5"`, repository `github.com/fastify/fastify-type-provider-zod`,
  first published `2026-04-19`.
- `npm view fastify-type-provider-zod versions description repository.url time.created`:
  versions `1.1.7` through `7.0.0`, identical description string `"Zod Type
  Provider for Fastify@5"`, repository `github.com/turkerdev/fastify-type-provider-zod`,
  first published `2022-03-23`.
- Neither package's npm metadata nor its README marks the other as deprecated
  or renamed. Both export the exact same public surface
  (`ZodTypeProvider`, `validatorCompiler`, `serializerCompiler`,
  `createSerializerCompiler`) and the exact same usage pattern.

## Decision

Pin **`@fastify/type-provider-zod` (v1.0.0, `fastify` GitHub org)**.

Rationale:
- It is published under the official `fastify` scope, matching the naming
  convention of every other first-party Fastify plugin already implied by
  this stack (`@fastify/*`), rather than an unscoped community package.
- The identical `"Zod Type Provider for Fastify@5"` npm description on both
  packages, combined with the scoped package's first release landing well
  after the unscoped package's v6 line, is consistent with the `fastify` org
  publishing an official continuation rather than an unrelated competing
  package — there is no functional divergence in the exported API surface to
  contradict that reading.
- Both packages require Zod `>=4.2`; this repo pins `zod@4.6.1`, so either
  package would compile, but the official-scope package is the safer long-term
  default (npm advisories and future Fastify major-version support are more
  likely to track the `fastify`-org package first).
- `fastify-type-provider-zod` (turkerdev) remains a documented, viable
  fallback per `docs/adr/0000-package-legitimacy-approvals.md` if the scoped
  package is ever abandoned.

## Consequence

All Fastify routes in this repo are typed with `.withTypeProvider<ZodTypeProvider>()`
from `@fastify/type-provider-zod`. `apps/control-plane/src/app.ts` sets
`validatorCompiler`/`serializerCompiler` from this package once, at app
construction, and every route plugin (`routes/health.ts` and later plans'
`routes/auth.ts`, `routes/setup.ts`, `routes/sessions.ts`) imports
`ZodTypeProvider` from the same package. `fastify-type-provider-zod`
(unscoped) must never appear alongside it in `package.json` — the two
packages export incompatible copies of the same type-level machinery and
mixing them would break type inference across route files.
