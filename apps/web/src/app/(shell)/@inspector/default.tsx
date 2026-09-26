// 08-09-PLAN.md Task 1 (D-08, UI-11): the empty default for the `@inspector` parallel-route slot.
// Phase 13 owns the slot's first real content (a nested route under this same `@inspector`
// directory) -- this file's only job, forever until that phase, is to return `null`. Returning
// `null` here -- rather than an empty wrapper element -- is exactly what keeps the shell layout's
// `<aside data-testid="shell-inspector-slot">` at zero width and with no border at every viewport:
// there is no markup to measure, no data fetch and no copy that could describe unreleased
// v0.2+ functionality (CLAUDE.md SS8, 08-UI-SPEC.md SS9 #19 "no coming-soon copy").
export default function InspectorDefault() {
  return null;
}
