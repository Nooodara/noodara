import type { ReactNode } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { LazyMotion, animate as animateMotionValue, m, useMotionValue, type PanInfo } from 'motion/react';
import { X } from 'lucide-react';
import { Button } from './Button.js';
import { cn } from './cn.js';
import { SPRING, toMotionSpring } from './motion-tokens.js';
import { useCloseSource } from './use-close-source.js';
import { useReducedMotionPreference } from './use-reduced-motion-preference.js';

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

// A ceiling on the velocity handed off to the closing spring (see `handleDragEnd`) -- Motion's own
// `useVelocity` docs use a [-3000, 3000] px/s example range; this is a generous multiple of that,
// wide enough to never visibly cap a real flick, narrow enough to guard against the
// effectively-infinite value a near-zero elapsed time between the last two pointer samples can
// otherwise produce.
const MAX_HANDOFF_VELOCITY_PX_PER_S = 8000;

// Mobile round 1 adjustment (09-14 checkpoint): the panel is no longer a fixed 480px -- on a
// narrow viewport (e.g. a 440px-wide phone) it is full width, capped at 480px on wider ones
// (PANEL_CLASSES below). This constant is now only the *fallback* used when the real, measured
// panel width (`contentRef.current.getBoundingClientRect().width`, read in `handleDragEnd`) is
// unavailable (e.g. jsdom, which reports 0 for every element's layout box) -- the drag-dismiss
// distance threshold and the closing hand-off distance must both track the panel's own actual
// on-screen width, never this constant alone, or a phone-width panel would require dragging past
// the old desktop 480px midpoint (240px) to dismiss instead of its own, much narrower, midpoint.
const PANEL_WIDTH_PX = 480;

// A deliberately small settle-in offset for the drag surface's own entry flourish (see the
// `useEffect` in `Sheet` that consumes this) -- large enough to be perceptible, small enough to
// never look like a second, competing slide-in against the outer CSS transition already carrying
// the actual 480px distance.
const ENTRY_SETTLE_OFFSET_PX = 8;

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
  'fixed inset-y-0 right-0 z-50 flex h-full w-full max-w-[480px] flex-col',
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
// `panelWidthPx` is the caller's own real, measured panel width (Mobile round 1 adjustment,
// 09-14): the position-based fallback must be a fraction of whatever width the panel is actually
// rendered at (full width on a phone, capped at 480px above that), never the old hardcoded 480px
// constant, or a phone-width panel's own midpoint-snap threshold would sit off past its own right
// edge.
function decidesToClose(info: PanInfo, panelWidthPx: number): boolean {
  return info.velocity.x > DRAG_CLOSE_VELOCITY_PX_PER_S || info.offset.x > panelWidthPx / 2;
}

// 13-20 A2: every caller drives Sheet controlled, without a DialogPrimitive.Trigger, so Radix
// Dialog's own close-focus target (its internal triggerRef) is null and focus fell to <body>.
// The opener is remembered in a layout effect -- it runs before the portal mounts and before
// FocusScope's passive effect moves focus into the panel -- and focused again in
// onCloseAutoFocus, whatever closed the sheet (Escape, Close, a caller's Cancel, overlay click).
// An opener that is gone by then (e.g. a menu item) leaves Radix's default in place.
function useReturnFocus(open: boolean): (event: Event) => void {
  const openerRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
  }, [open]);
  return (event) => {
    const opener = openerRef.current;
    openerRef.current = null;
    if (!opener?.isConnected) return;
    event.preventDefault();
    opener.focus();
  };
}

export function Sheet({ open, onOpenChange, title, children, footer, 'data-testid': testId }: SheetProps) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const handleCloseAutoFocus = useReturnFocus(open);
  const { closeSource } = useCloseSource(open, contentRef);
  // D-13 (09-04-PLAN.md Task 2): `useReducedMotionPreference` (not motion/react's own
  // `useReducedMotion`) is the effective preference here -- a forced `html[data-motion]`
  // attribute wins over the OS media query, exactly as the CSS `motion-safe`/`motion-reduce`
  // variants (packages/ui/theme.css) already do. Motion's own reduced-motion handling stays
  // library-internal and unrelated to this read (D19: `motion` stays confined to this file).
  const prefersReducedMotion = useReducedMotionPreference();
  // Backed by a `MotionValue`, not the declarative `animate` prop: brief §7.4 step 8's velocity
  // handoff ("entregá la velocidad de release como velocidad inicial del spring, para que no haya
  // costura entre arrastrar y animar") needs the CLOSING animation to start from the release
  // point carrying the release velocity -- a declarative `animate={{ x: 0 }}` target has no way to
  // conditionally continue in the release direction instead of snapping back, so `handleDragEnd`
  // below drives this value with the standalone `animate()` function instead.
  const x = useMotionValue(0);
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

  // 08-UI-SPEC.md §7.2's durations table: "Sheet entry: translateX + spring: SPRING.drawer". The
  // outer `DialogPrimitive.Content`'s own unchanged CSS transition is what visibly slides the
  // panel in (this stays untouched to avoid a doubled transform across the two nested elements);
  // this small settle-in on the drag surface itself is a second, subtle layer riding on top of
  // that CSS slide, so SPRING.drawer genuinely governs part of what's on screen during entry, not
  // just a token named in a comment. Imperative (`animate()` in an effect), not the declarative
  // `animate` prop -- a persistent declarative target on `x` is exactly what fought the
  // momentum-handoff animation in `handleDragEnd` (see the comment on `x` above).
  useEffect(() => {
    if (open) {
      x.set(ENTRY_SETTLE_OFFSET_PX);
      void animateMotionValue(x, 0, toMotionSpring(SPRING.drawer));
    }
  }, [open, x]);

  function handleDragEnd(_event: PointerEvent | MouseEvent | TouchEvent, info: PanInfo): void {
    // Mobile round 1 adjustment (09-14 checkpoint): read the panel's own real width off its DOM
    // node rather than assuming the old fixed 480px -- falls back to the constant only when the
    // measurement is unavailable (0-or-absent, e.g. jsdom, which never lays elements out).
    const measuredWidthPx = contentRef.current?.getBoundingClientRect().width;
    const panelWidthPx = measuredWidthPx !== undefined && measuredWidthPx > 0 ? measuredWidthPx : PANEL_WIDTH_PX;
    if (decidesToClose(info, panelWidthPx)) {
      // Brief §7.4 steps 7-8: project momentum forward and hand its velocity off as the closing
      // spring's own initial velocity -- SPRING.momentum (UI-SPEC's own "only when the gesture
      // itself carried momentum" comment) is the one case that constant exists for. The DOM
      // node's own CSS-transition-based exit (owned by the outer `DialogPrimitive.Content`,
      // untouched) still governs when Radix actually removes it; `onOpenChange(false)` is only
      // called once this handoff animation finishes, not before, so the two never race.
      //
      // `info.velocity.x` is clamped to a finite, sane range before being handed to the spring: a
      // near-zero elapsed time between the last two pointer samples (an extremely fast, short
      // flick -- exactly the case this branch exists for) can otherwise produce an effectively
      // infinite/non-finite velocity, which breaks the spring's own settle-detection math and
      // leaves the returned promise never resolving (found empirically, via this task's own
      // Playwright flick test hanging instead of closing).
      const handoffVelocity = Number.isFinite(info.velocity.x)
        ? Math.sign(info.velocity.x) * Math.min(Math.abs(info.velocity.x), MAX_HANDOFF_VELOCITY_PX_PER_S)
        : DRAG_CLOSE_VELOCITY_PX_PER_S;
      void animateMotionValue(x, panelWidthPx, toMotionSpring(SPRING.momentum, { velocity: handoffVelocity })).then(
        () => {
          onOpenChange(false);
        },
      );
    } else {
      // Released without crossing the close threshold -- spring back to rest. Critically damped,
      // no overshoot (SPRING.default's own comment): this is deliberately not SPRING.momentum,
      // per UI-SPEC's token table reserving that spring for a release that actually carries the
      // gesture through to a close.
      void animateMotionValue(x, 0, toMotionSpring(SPRING.default));
    }
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={OVERLAY_CLASSES} data-sheet-overlay="" />
        <DialogPrimitive.Content
          ref={contentRef}
          className={cn(PANEL_CLASSES, instantClose && INSTANT_CLOSE_CLASS)}
          data-testid={testId}
          aria-describedby={undefined}
          onCloseAutoFocus={handleCloseAutoFocus}
        >
          {/* D19: `LazyMotion` scoped to exactly this subtree -- `strict` makes any `motion.*`
              usage anywhere else in the tree throw at runtime instead of silently working. The
              drag surface is a child of `DialogPrimitive.Content`, not a replacement for it:
              Content itself (the element above, carrying `role="dialog"`, the focus trap, Esc
              and outside-click) is completely untouched by this change (T-08-34). */}
          <LazyMotion features={loadFeatures} strict>
            <m.div
              className={DRAG_SURFACE_CLASSES}
              // Task 3 (08-12-PLAN.md, UI-06 §7.4): the only DOM node whose `transform` actually
              // moves during a drag -- the outer `DialogPrimitive.Content` above owns the
              // open/closed CSS-transition position, this inner surface owns the live gesture
              // offset on top of it. A dedicated testid (not reusing `data-testid`, which stays
              // on the semantic dialog element per every existing test/consumer) is how the E2E
              // suite locates exactly this node without depending on Motion's own DOM shape.
              data-testid={testId !== undefined ? `${testId}-drag-surface` : undefined}
              // `x` is an externally-owned `MotionValue` (`style={{ x }}`, not the declarative
              // `animate` prop): a persistent `animate={{ x: ... }}` target would re-assert
              // itself the instant `onDragEnd` finishes, fighting the momentum-handoff animation
              // `handleDragEnd` starts below (found empirically -- this is exactly the failure
              // mode Task 3's own "handoff" Playwright test caught). The drag gesture and this
              // component's own two explicit `animate()` calls (close-with-momentum / snap-back)
              // are the only things that ever move this value.
              style={{ x }}
              drag={prefersReducedMotion ? false : 'x'}
              dragConstraints={{ left: 0, right: 0 }}
              dragElastic={0.15}
              dragMomentum
              onDragEnd={handleDragEnd}
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
