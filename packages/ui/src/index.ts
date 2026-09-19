// Single barrel export for @noodara/ui (the Noodara design system).
//
// Empty for now -- Task 1 of Plan 05-06 only scaffolds the package. Later plans append
// component exports here as they land: 05-08, 05-09, 05-22, 05-23, 05-24, 05-25 (see
// 05-06-PLAN.md's must_haves.artifacts and each of those plans' own frontmatter for the
// exact component -> plan assignment). Keep the export list alphabetical as it grows, so
// appends stay reviewable in diffs.
//
// Never export anything from `src/testing/` here -- that surface is reachable only through
// the explicit `@noodara/ui/testing` subpath (see packages/ui/src/testing/render.tsx), is
// excluded from coverage, and Plan 05-21's `check:ui-safety` gate fails if any non-test file
// imports it.
export {};
