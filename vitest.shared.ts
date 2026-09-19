import { fileURLToPath } from 'node:url';
import type { AliasOptions } from 'vite';

// Single source of the @noodara/domain source aliases used by both vitest.config.ts (unit) and
// vitest.integration.config.ts (integration). packages/domain's `exports` map points at its
// built `dist` output (01-16-PLAN.md Task 2) so plain Node and every spawned child process
// resolve the real production artifact — but every *in-process* Vitest run must keep resolving
// straight to packages/domain/src, or QA-02's 95%/95% coverage gate (scoped to
// packages/domain/**, see vitest.config.ts's coverage.include) would silently start measuring
// dist instead of source, and unit tests would require a build step they must never need.
//
// Ordering rule (load-bearing): a Vite *string* alias matches by prefix, so the four subpath
// entries must come before the bare package entry, or "@noodara/domain" would match first and
// swallow "@noodara/domain/security" too. The bare entry therefore uses the regex
// /^@noodara\/domain$/ so it can only ever match the exact specifier.
export const domainSourceAliases: AliasOptions = [
  {
    find: '@noodara/domain/server',
    replacement: fileURLToPath(new URL('./packages/domain/src/server/index.ts', import.meta.url)),
  },
  {
    find: '@noodara/domain/security',
    replacement: fileURLToPath(new URL('./packages/domain/src/security/index.ts', import.meta.url)),
  },
  {
    find: '@noodara/domain/validators',
    replacement: fileURLToPath(new URL('./packages/domain/src/validators/index.ts', import.meta.url)),
  },
  {
    find: '@noodara/domain/activity',
    replacement: fileURLToPath(new URL('./packages/domain/src/activity/index.ts', import.meta.url)),
  },
  {
    find: '@noodara/domain/discovery',
    replacement: fileURLToPath(new URL('./packages/domain/src/discovery/index.ts', import.meta.url)),
  },
  {
    find: /^@noodara\/domain$/,
    replacement: fileURLToPath(new URL('./packages/domain/src/index.ts', import.meta.url)),
  },
];

// Same rationale as domainSourceAliases above, for @noodara/ssh (02-CONTEXT.md, ADR 0003):
// packages/ssh's `exports` map points at its built `dist` output, but every in-process Vitest
// run must keep resolving straight to packages/ssh/src so unit tests never require a build step.
//
// `@noodara/ssh/testing` (02-04-PLAN.md) resolves to a Vitest-only source file
// (packages/ssh/src/testing/raw-ssh2.ts) with no `exports` map entry of its own — it is never
// reachable from plain Node, only from an in-process Vitest run aliasing straight to source,
// exactly like the bare specifier below. Ordering rule (load-bearing, same reason as
// domainSourceAliases): the subpath entry must come before the bare regex entry so a caller can
// tell them apart, even though the bare entry's regex form already can't match the subpath.
export const sshSourceAliases: AliasOptions = [
  {
    find: '@noodara/ssh/testing',
    replacement: fileURLToPath(new URL('./packages/ssh/src/testing/raw-ssh2.ts', import.meta.url)),
  },
  {
    find: /^@noodara\/ssh$/,
    replacement: fileURLToPath(new URL('./packages/ssh/src/index.ts', import.meta.url)),
  },
];

// Same rationale as domainSourceAliases/sshSourceAliases above, for @noodara/ui (05-06-PLAN.md
// Task 2): packages/ui's `exports` map points at its built `dist` output, but every in-process
// Vitest run (including apps/web's future component tests, once that app exists) must keep
// resolving straight to packages/ui/src -- otherwise every component test would require a build
// before `pnpm test` could run. Ordering rule (load-bearing, same reason as the arrays above): the
// `@noodara/ui/testing` subpath entry must come before the bare `@noodara/ui` regex entry, longest
// specifier first, so a caller resolving the subpath is never swallowed by the bare match.
export const uiSourceAliases: AliasOptions = [
  {
    find: '@noodara/ui/testing',
    replacement: fileURLToPath(new URL('./packages/ui/src/testing/render.tsx', import.meta.url)),
  },
  {
    find: /^@noodara\/ui$/,
    replacement: fileURLToPath(new URL('./packages/ui/src/index.ts', import.meta.url)),
  },
];
