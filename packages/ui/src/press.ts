import { cn } from './cn.js';

// PRESS_CLASSES (UI-05, 08-UI-SPEC.md §7.1/§7.2, docs/ui-build-prompt.md §7.3) -- the ONE press
// feedback definition in the system. Every pressable primitive (Button, ListRow, CopyButton,
// FileButton, SegmentedControl -- and RowMenu/AccountMenu/NavTree/Dialog once plan 08-20 composes
// this same constant alongside their own keyboard-no-animation branch) consumes this exact
// string. A component adding its own `active:scale-*` literal is a bug -- see the contract test
// in press.test.ts, and the `grep -rl "active:scale" packages/ui/src` check plan 08-13's
// acceptance criteria run, which must list only this file.
//
// Names `transform` explicitly (never the blanket "all properties" transition,
// docs/ui-build-prompt.md §9 #9) and only
// animates transform/opacity, never a layout-triggering property (§9 #11). `motion-safe:` gates
// the scale so `prefers-reduced-motion` never sees a transform; `motion-reduce:` dims opacity on
// `:active` instead, matching UI-10. `disabled:` overrides both at higher specificity (two
// pseudo-classes beat one) so a disabled control never looks pressable even if a caller
// mis-wires `:active` onto it -- native disabled buttons never actually enter `:active`, but this
// keeps the guarantee explicit and testable rather than implicit browser behaviour.
export const PRESS_CLASSES = cn(
  'motion-safe:transition-[transform] motion-safe:duration-[160ms] motion-safe:ease-[var(--ease-out)]',
  'motion-safe:active:scale-[0.97]',
  'motion-reduce:transition-[opacity] motion-reduce:duration-[160ms] motion-reduce:ease-[var(--ease-out)]',
  'motion-reduce:active:opacity-80',
  'disabled:active:scale-100 disabled:active:opacity-100',
);
