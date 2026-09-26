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

// 08-12-PLAN.md Task 2 (found empirically, via this plan's own Task 3 Playwright suite hanging
// instead of closing): `damping`/`response` above are the SwiftUI `.spring(response:
// dampingFraction:)` convention 08-UI-SPEC.md's own token table is written in -- Motion's real
// `type: 'spring'` transition does NOT recognise either key by that name at all (its actual keys
// are `stiffness`/`damping`/`mass`, where `damping` is a raw coefficient in wildly different
// units, not a 0-1 damping *ratio*). Passing `SPRING.momentum` directly as a Motion transition
// silently produces an almost undamped spring (Motion ignores the unrecognised `response` key and
// treats `damping: 0.8` as essentially zero damping in its own units), which oscillates for
// seconds instead of settling -- exactly the symptom this plan's flick-close E2E test caught.
// This is the standard, widely-documented response/dampingFraction -> stiffness/damping
// conversion (mass fixed at 1): `stiffness = (2π / response)²`, `damping = 4π · dampingFraction /
// response`. Sanity check baked into the formula itself: `SPRING.default`'s `damping: 1.0` (a
// dampingFraction of exactly 1, i.e. critically damped) converts to a `damping` that exactly
// equals `2·√stiffness` -- the textbook critical-damping point -- confirming the conversion is
// correct, not just plausible-looking.
export function toMotionSpring(
  config: SpringConfig,
  extra?: { readonly velocity?: number },
): { readonly type: 'spring'; readonly stiffness: number; readonly damping: number; readonly mass: number; readonly velocity?: number } {
  const mass = 1;
  const stiffness = Math.pow((2 * Math.PI) / config.response, 2) * mass;
  const damping = (4 * Math.PI * config.damping * mass) / config.response;
  return { type: 'spring', stiffness, damping, mass, ...extra };
}
