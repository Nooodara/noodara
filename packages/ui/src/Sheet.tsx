import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { LazyMotion, m, useReducedMotion, type PanInfo } from 'motion/react';
import { X } from 'lucide-react';
import { Button } from './Button.js';
import { cn } from './cn.js';
import { SPRING } from './motion-tokens.js';
import { useCloseSource } from './use-close-source.js';

// D19/UI-06 (08-12-PLAN.md Task 2): the one place in this codebase `motion` may be imported.
// `LazyMotion`'s `features` prop takes this lazy-import form so the `domMax` bundle (drag/pan
// support, +25kb -- see motion-features.js's own header for why this exact bundle, not the
// smaller one, is required) is never in the initial page payload, only fetched once a Sheet is
// about to render (T-08-33).
const loadFeatures = () => import('./motion-features.js').then((res) => res.default);

// Brief §7.4 step 6: "velocidad > 0.11 px/ms cierra sin importar la distancia recorrida" -- this
// converts to 110 px/s on the assumption that Motion's `info.velocity` is px/s (Motion's own
// `useVelocity` docs use a [-3000, 3000] example range, consistent with px/s; research Pitfall 3,
// Assumption A3). Calibrated empirically, not derived: tune this single named constant during the
// G2/G3 live review (D-14) -- never scatter the number elsewhere in this file.
const DRAG_CLOSE_VELOCITY_PX_PER_S = 110;

// The panel's own `w-[480px]` (PANEL_CLASSES below) as a plain number -- the distance a drag must
// cross before "position" alone (rather than velocity) decides to close, per brief §7.4 step 6's
// fallback and UI-06's midpoint-snap acceptance criterion.
const PANEL_WIDTH_PX = 480;

export interface SheetProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly 'data-testid'?: string;
}

// Translucent --surface-1 (skill SS2.3's "Translucent" elevation level) at the opacity/blur pair
// the skill names for sidebar/toolbar/sheets -- no bespoke token, the same treatment those
// surfaces already use.
const OVERLAY_CLASSES = 'fixed inset-0 z-40 bg-canvas/72';

// UI-03 (08-06-PLAN.md Task 1, 08-UI-SPEC.md SS5.1/5.2): `--shadow-floating` applies to exactly
// four components -- Sheet, Dialog, RowMenu, AccountMenu (scripts/check-ui-safety.mjs's
// SHADOW_ALLOWLIST is the machine-checked gate that proves no other component ever gets one).
// The new surface-elevated alias replaces the old surface-1 background so dark mode sits one step
// lighter (surface-2); light stays byte-identical (the alias resolves to surface-1 there).
//
// UI-10 (08-06-PLAN.md Task 2, 08-UI-SPEC.md SS10) -- two intentional fallbacks, both expressed as
// Tailwind arbitrary variants on this same class constant (no second stylesheet, no literal
// colour): under `prefers-reduced-transparency: reduce` the panel drops to a fully opaque
// surface-elevated background with `backdrop-filter: none` (the arbitrary-property form, since
// Tailwind composes backdrop-blur/backdrop-saturate into one shorthand and only setting the blur
// half to `none` would leave the saturate half still applying a filter); under
// `prefers-contrast: more` (Tailwind's built-in `contrast-more:` variant) the hairline swaps to
// the strong token and the background is pushed toward fully opaque too, both real boundaries a
// low-contrast border/translucent panel could otherwise erase (T-08-18/T-08-19).
//
// UI-10 (08-06-PLAN.md Task 3, 08-UI-SPEC.md SS10) -- the reduced-motion alternative: the whole
// `data-[state=*]:translate-x-*` pair now sits inside `motion-safe:` alongside the transition
// itself, so under `prefers-reduced-motion: reduce` the panel never translates at all, at any
// point; `motion-reduce:transition-opacity`/`motion-reduce:duration-[var(--duration-panel)]`
// (paired with `motion-reduce:data-[state=closed]:opacity-0`, open needing no explicit class since
// full opacity is the element's own default) replace the slide with a short opacity crossfade --
// no translate, no scale, no spring, matching every other transition in the redesign's motion
// table (08-UI-SPEC.md SS10's own worked comment block). Verified end to end (real browser,
// `page.emulateMedia`) by `tests/e2e/a11y-fallbacks.spec.ts`'s `@a11y-fallbacks` tests -- jsdom
// cannot resolve `prefers-reduced-motion` at all.
const PANEL_CLASSES = cn(
  'fixed inset-y-0 right-0 z-50 flex h-full w-[480px] flex-col',
  'rounded-l-lg border-l border-hairline bg-surface-elevated/72 backdrop-blur-xl backdrop-saturate-[1.8]',
  'shadow-[var(--shadow-floating)]',
  '[@media(prefers-reduced-transparency:reduce)]:bg-surface-elevated',
  '[@media(prefers-reduced-transparency:reduce)]:[backdrop-filter:none]',
  'contrast-more:border-hairline-strong contrast-more:bg-surface-elevated',
  'motion-safe:transition-transform motion-safe:duration-[var(--duration-sheet)] motion-safe:ease-[var(--ease-standard)]',
  'motion-safe:data-[state=open]:translate-x-0 motion-safe:data-[state=closed]:translate-x-full',
  'motion-reduce:transition-opacity motion-reduce:duration-[var(--duration-panel)] motion-reduce:data-[state=closed]:opacity-0',
);

// 08-12-PLAN.md Task 2 (brief §9 #10, 08-UI-SPEC.md §7.3): appended to `PANEL_CLASSES` only while
// the in-flight close is keyboard-initiated (`useCloseSource`, owned by 08-04). `!duration-0`
// overrides the `motion-safe:duration-[var(--duration-sheet)]`/`motion-reduce:duration-[var(--
// duration-panel)]` pair above (Tailwind's `!` important-modifier wins the specificity fight
// against those un-flagged utilities), so Radix's own CSS-transition-duration-based exit
// deferral sees a zero duration and unmounts the panel immediately -- no `onEscapeKeyDown`
// override, no second keydown listener, the existing `check:ui-safety` gate for both stays green.
const INSTANT_CLOSE_CLASS = '!duration-0';

const DRAG_SURFACE_CLASSES = 'flex h-full w-full flex-col';

const HEADER_CLASSES = 'flex items-center justify-between border-b border-hairline px-8 py-6';
// `min-h-0` is required alongside `flex-1 overflow-y-auto` here: a flex item's default
// `min-height: auto` otherwise lets it grow to fit its content instead of being constrained by
// the panel's own height, so real overflowing content (e.g. a long form) pushes the footer off
// screen entirely with nothing left to scroll -- a real bug this component's own test suite never
// exercised (its fixtures never had enough content to overflow), found and fixed while wiring
// Plan 05-17's add/edit server sheet against a real browser viewport.
const BODY_CLASSES = 'min-h-0 flex-1 overflow-y-auto px-8 py-8';
const FOOTER_CLASSES = 'flex items-center justify-end gap-2 border-t border-hairline px-8 py-6';

// Sheet (05-UI-SPEC.md SS2.4, skill SS4.5) -- a 480px right-side panel on Radix Dialog. Radix
// owns focus trapping, Esc-to-close and outside-click dismissal entirely on its own (skill SS7,
// SS8's "Radix traps focus and closes on Esc -- do not override it"); this component adds none
// of those dismiss-event handlers or focus-style overrides itself. Real
// focus-trap/Esc/outside-click behaviour is verified by Plan 05-17's `@sheet` Playwright spec,
// not this file's jsdom test -- jsdom does not implement the layout and focus mechanics Radix's
// FocusScope depends on. `aria-describedby={undefined}` is Radix's own documented way to opt out
// of its "missing Description" dev warning when a sheet genuinely has no separate description
// beyond its title and body content (the body is exactly the caller's own composed content, not
// a fixed sentence this component could sensibly duplicate into a Description).
// 08-12-PLAN.md Task 2 (UI-06, D19): the panel's drag-to-dismiss surface. Kept as a plain
// function (not inlined into `Sheet`) so `handleDragEnd`'s only reason to change is the release
// decision itself -- brief §7.4 step 6, "decisión en el release por el signo de la velocidad, no
// por la posición", with the panel's own half-width as the position-based fallback UI-06 also
// names ("midpoint-snap").
function decidesToClose(info: PanInfo): boolean {
  return info.velocity.x > DRAG_CLOSE_VELOCITY_PX_PER_S || info.offset.x > PANEL_WIDTH_PX / 2;
}

export function Sheet({ open, onOpenChange, title, children, footer, 'data-testid': testId }: SheetProps) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const { closeSource } = useCloseSource(open, contentRef);
  const prefersReducedMotion = useReducedMotion();
  // Latched, not derived inline: by the time this Sheet re-renders with `open === false`,
  // `useCloseSource`'s own capture-phase keydown listener (08-04) has already run for the same
  // event, so `closeSource()` already reports 'keyboard' -- this effect just carries that one
  // read into a piece of render state the className below can react to for the rest of this
  // close's CSS-transition lifetime (see INSTANT_CLOSE_CLASS above).
  const [instantClose, setInstantClose] = useState(false);

  useEffect(() => {
    if (!open) {
      setInstantClose(closeSource() === 'keyboard');
    }
  }, [open, closeSource]);

  function handleDragEnd(_event: PointerEvent | MouseEvent | TouchEvent, info: PanInfo): void {
    if (decidesToClose(info)) {
      onOpenChange(false);
    }
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={OVERLAY_CLASSES} />
        <DialogPrimitive.Content
          ref={contentRef}
          className={cn(PANEL_CLASSES, instantClose && INSTANT_CLOSE_CLASS)}
          data-testid={testId}
          aria-describedby={undefined}
        >
          {/* D19: `LazyMotion` scoped to exactly this subtree -- `strict` makes any `motion.*`
              usage anywhere else in the tree throw at runtime instead of silently working. The
              drag surface is a child of `DialogPrimitive.Content`, not a replacement for it:
              Content itself (the element above, carrying `role="dialog"`, the focus trap, Esc
              and outside-click) is completely untouched by this change (T-08-34). */}
          <LazyMotion features={loadFeatures} strict>
            <m.div
              className={DRAG_SURFACE_CLASSES}
              drag={prefersReducedMotion === true ? false : 'x'}
              dragConstraints={{ left: 0, right: 0 }}
              dragElastic={0.15}
              dragMomentum
              onDragEnd={handleDragEnd}
              animate={{ x: 0 }}
              transition={SPRING.drawer}
            >
              <div className={HEADER_CLASSES}>
                <DialogPrimitive.Title className="text-title font-semibold text-ink">{title}</DialogPrimitive.Title>
                <DialogPrimitive.Close asChild>
                  <Button type="button" variant="ghost" aria-label="Close">
                    <X aria-hidden="true" size={16} strokeWidth={1.5} />
                  </Button>
                </DialogPrimitive.Close>
              </div>
              <div className={BODY_CLASSES}>{children}</div>
              {footer ? <div className={FOOTER_CLASSES}>{footer}</div> : null}
            </m.div>
          </LazyMotion>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
