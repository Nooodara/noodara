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
export const sshSourceAliases: AliasOptions = [
  {
    find: /^@noodara\/ssh$/,
    replacement: fileURLToPath(new URL('./packages/ssh/src/index.ts', import.meta.url)),
  },
];
