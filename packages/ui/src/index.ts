// Single barrel export for @noodara/ui (the Noodara design system).
//
// Plan 05-22 adds the first exports: the two pure helpers (`cn`, the tone map) every later
// component rests on. Later plans append component exports here as they land: 05-23, 05-24,
// 05-25 (see 05-06-PLAN.md's must_haves.artifacts and each of those plans' own frontmatter for
// the exact component -> plan assignment). Keep the export list alphabetical as it grows, so
// appends stay reviewable in diffs.
//
// Never export anything from the `src/testing` subdirectory here -- that surface is reachable
// only through the explicit `@noodara/ui/testing` subpath (see the render harness module under
// `src/testing/`), is excluded from coverage, and Plan 05-21's `check:ui-safety` gate fails if
// any non-test file imports it.
export { cn } from './cn.js';
export { discoveryCheckTone, serverStatusTone, STATUS_WORDS } from './tone.js';
export type { Tone } from './tone.js';
