# ADR 0003: Runtime entrypoints and module resolution — build for prod, `tsx` for dev

## Status

Accepted — 2026-09-12

## Context

The codebase uses NodeNext `.js` relative specifiers throughout its source
(`import { env } from './env.js'`), which is `tsc`'s own convention for
ESM output under `"module": "NodeNext"` — the specifier names the file the
compiler will *emit*, not the `.ts` file the specifier is written next to.
Plain Node's `--experimental-strip-types` (the loader `tsx` also builds on)
strips types in place but does not remap a `.js` specifier onto a sibling
`.ts` file, and `packages/domain`'s `package.json` `exports` map pointed
directly at `.ts` sources with no build step in front of them. The result:
both `apps/control-plane`'s `pnpm dev` and its built `dist/server.js`
crashed with `ERR_MODULE_NOT_FOUND` before INST-06's fail-fast environment
validation ever ran — a real, reproducible defect (`01-VERIFICATION.md`'s
BLOCKER) distinct from any of phase 1's 33 previously-executed tasks.

The defect survived to the end of the phase because every "boot" proof up
to that point ran through Vitest's own module transform
(`startApp()`/`startTestApp()`) or through `tsx` directly (`db:migrate`,
the `noodara` CLI) — nothing exercised the actual committed `dev` script or
a plain-`node` run of the built artifact. Plan 01-16 closed the defect
itself; this ADR records the shape of the fix as shipped, and Plan 01-17's
`boot-smoke` CI job (`.github/workflows/ci.yml`) is the standing gate that
makes a regression here impossible to merge silently.

## Decision

Three parts, all shipped in Plan 01-16:

1. **`packages/domain` gets a real `tsc` build.** `packages/domain/tsconfig.build.json`
   emits to `dist/` (excluding `*.test.ts`) with `.d.ts` declarations, and
   `packages/domain/package.json`'s `exports` map is rewritten to a
   conditional `{ types, default }` shape pointing at `dist/*.js` /
   `dist/*.d.ts`, through the same five stable entrypoints as before
   (`.`, `./server`, `./security`, `./validators`, `./activity`). Nothing
   downstream needs to know a build happened — the public import surface is
   unchanged.

2. **Production runs `node dist/server.js` with zero TypeScript loader in
   the runtime path.** `apps/control-plane/package.json` gains a `start`
   script (`node dist/server.js`) alongside its existing `build`
   (`tsc -p tsconfig.build.json && node scripts/copy-migration-assets.mjs`);
   the root `package.json`'s `start` forwards to it
   (`pnpm --filter @noodara/control-plane start`). `apps/control-plane/dist`
   is self-contained: `copy-migration-assets.mjs` copies
   `src/db/migrations` (`.sql` + `meta/_journal.json`) into
   `dist/db/migrations` so a deployed `dist/` needs nothing from `src/` at
   runtime, and `tsconfig.build.json` excludes `*.test.ts` so no compiled
   test file ships. This is exactly what phase 6's installer packages into
   the production Docker image.

3. **Development runs `tsx watch src/server.ts` (`pnpm dev`).** This reuses
   the loader already behind `db:migrate` and the `noodara` operator CLI —
   no new dependency, no new mental model for a contributor who already
   runs those commands. `turbo.json`'s `dev` task declares
   `dependsOn: ["^build"]` (so a clean checkout's literal root `pnpm dev`
   builds `packages/domain` first) and an explicit `passThroughEnv`
   allowlist naming every variable in `apps/control-plane/src/env.ts`'s
   `Env` interface — required because Turborepo 2's default strict-env mode
   silently strips any environment variable not declared in `env` /
   `passThroughEnv` / `globalEnv` / `globalPassThroughEnv` before spawning a
   task. This was not anticipated when the fix was scoped; it surfaced
   empirically when the turbo-driven root `pnpm dev` crashed with all five
   `NOODARA_CONFIG_ERROR` lines even under a fully valid environment, while
   `pnpm --filter @noodara/control-plane dev` (which bypasses turbo)
   received the same environment correctly.

In-process tests keep resolving `@noodara/domain`'s five specifiers to
`packages/domain/src`, not `dist`, via a single shared
`vitest.shared.ts` (`domainSourceAliases`, a set of Vitest `resolve.alias`
entries wired into both `vitest.config.ts` and
`vitest.integration.config.ts`). This is
deliberate, not an oversight: QA-02's 95%/95% statement/branch threshold is
scoped to `packages/domain/**` source, and resolving in-process tests to
`dist` would silently zero that coverage measurement while still reporting
green.

## Rejected alternatives

- **Rewrite every relative import to a `.ts` specifier.** Breaks `tsc`'s
  own emit convention under `NodeNext` and fights the entire ecosystem
  norm rather than the one loader that doesn't support it; would also
  require touching every existing source file for no functional gain.
- **Ship `tsx` in the production image.** Puts a development loader in the
  runtime path permanently — extra startup cost and extra attack surface
  (a general-purpose TypeScript transform running against production
  input) for zero benefit once a build step exists, and works against the
  roadmap's thin-image goal for phase 6's Docker packaging.
- **Leave `packages/domain`'s `exports` pointing at `.ts` and require a
  loader everywhere that imports it.** Solves nothing — it just moves the
  same `ERR_MODULE_NOT_FOUND` class of defect one level up and guarantees
  phase 6's installer inherits it when it tries to run the built image
  under plain Node.

## Consequences

- `turbo.json`'s `lint`, `typecheck` and `dev` tasks all declare
  `dependsOn: ["^build"]`; a clean checkout must build `packages/domain`
  before typescript-eslint or `tsc --noEmit` can type-check
  `apps/control-plane` against it, and before `pnpm dev` can boot.
- Editing `packages/domain` source while `pnpm dev` is running requires a
  rebuild to reach the running control-plane process — `tsx watch` only
  watches `apps/control-plane/src`, not `packages/domain/dist`.
- `apps/control-plane/dist` is self-contained (migrations copied in, test
  files excluded), which is exactly the artifact phase 6's Docker image is
  expected to package and run with `node dist/server.js`.
- `tests/integration/boot/boot-command.test.ts` (4 cases: `start` fail-fast,
  `start` real boot, package-scoped `dev`, and a clean-tree turbo-driven
  root `pnpm dev` that deletes both `dist` directories) is the integration
  proof; `.github/workflows/ci.yml`'s `boot-smoke` job (Plan 01-17) is the
  CI gate that runs `pnpm build` then `pnpm test:boot` on every pull
  request, so a regression in this contract can no longer merge silently.
