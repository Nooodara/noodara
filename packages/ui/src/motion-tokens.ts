// 08-12-PLAN.md Task 2 (D19, UI-06, 08-UI-SPEC.md SS7.2/7.3 "Spring constants"): plain numeric
// spring configs for `motion`'s `useSpring`/`animate` API -- not CSS, since Tailwind/CSS has no
// spring namespace that maps onto a JS physics config. Imported by `Sheet.tsx` and nothing else
// (D19's "motion nowhere else" rule): `Sheet.tsx` is the only component this codebase allows to
// import `motion` at all, so a second importer of this file would itself be a D19 violation
// before it ever touched `motion` directly.
export interface SpringConfig {
  readonly damping: number;
  readonly response: number;
}

export const SPRING = {
  // Critically damped, no overshoot -- the default for any spring-driven transition that isn't
  // itself carrying gesture momentum.
  default: { damping: 1.0, response: 0.4 },
  // Only when the gesture itself carried momentum (a flick, a drag release) -- 08-UI-SPEC.md
  // SS7.2's "Bounce" row: permitted and scoped exclusively to this case.
  momentum: { damping: 0.8, response: 0.4 },
  // Sheet entry (08-UI-SPEC.md SS7.2's durations table, "Sheet entry" row).
  drawer: { damping: 0.8, response: 0.3 },
} as const satisfies Record<'default' | 'momentum' | 'drawer', SpringConfig>;
