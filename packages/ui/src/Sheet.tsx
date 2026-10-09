import type { ReactNode } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { LazyMotion, animate as animateMotionValue, m, useMotionValue, type PanInfo } from 'motion/react';
import { X } from 'lucide-react';
import { Button } from './Button.js';
import { cn } from './cn.js';
import { SPRING, toMotionSpring } from './motion-tokens.js';
import { decidesToClose, dragElasticFor, handoffVelocity, type SheetDragPhase } from './sheet-drag.js';
import { useCloseSource } from './use-close-source.js';
import { useReducedMotionPreference } from './use-reduced-motion-preference.js';

// D19/UI-06 (08-12-PLAN.md Task 2): the one place in this codebase `motion` may be imported.
// `LazyMotion`'s `features` prop takes this lazy-import form so the `domMax` bundle (drag/pan
// support, +25kb -- see motion-features.js's own header for why this exact bundle, not the
// smaller one, is required) is never in the initial page payload, only fetched once a Sheet is
// about to render (T-08-33).
const loadFeatures = () => import('./motion-features.js').then((res) => res.default);

// Release thresholds, the handoff clamp and the drag elastic live in ./sheet-drag.ts (pure).

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
// never look like a full slide-in (the outer panel mounts already open; only its exit animates).
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
// 14-26: the overlay fades out with the panel (opacity only, so the same under reduced motion).
const OVERLAY_CLASSES = 'fixed inset-0 z-40 bg-canvas/72 data-[state=closed]:animate-sheet-fade-exit';

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
// 14-26: the exit is a keyframe animation (theme.css `--animate-sheet-*`), not a transition.
// Radix Presence keeps a closing node mounted only while a CSS animation runs; with the old
// transition the panel left the DOM a few ms after any close. Motion allowed: slide out over
// --duration-sheet. Reduced motion (UI-10): an opacity fade only, no translate. Verified in a real
// browser by tests/e2e/a11y-fallbacks.spec.ts and keyboard-motion.spec.ts.
const PANEL_CLASSES = cn(
  'fixed inset-y-0 right-0 z-50 flex h-full w-full max-w-[480px] flex-col',
  'rounded-l-lg border-l border-hairline bg-surface-elevated/72 backdrop-blur-xl backdrop-saturate-[1.8]',
  'shadow-[var(--shadow-floating)]',
  '[@media(prefers-reduced-transparency:reduce)]:bg-surface-elevated',
  '[@media(prefers-reduced-transparency:reduce)]:[backdrop-filter:none]',
  'contrast-more:border-hairline-strong contrast-more:bg-surface-elevated',
  'motion-safe:data-[state=closed]:animate-sheet-exit',
  'motion-reduce:data-[state=closed]:animate-sheet-fade-exit',
);

// 08-12-PLAN.md Task 2 (brief §9 #10, 08-UI-SPEC.md §7.3): appended to the panel and overlay only
// while the close is keyboard-initiated (`useCloseSource`, owned by 08-04). `!animate-none` beats
// the exit animations above, so Presence sees `animation-name: none` and unmounts at once -- no
// `onEscapeKeyDown` override, no second keydown listener.
const INSTANT_CLOSE_CLASS = '!animate-none';

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
  // 14-26: latched during the render where `open` flips (React's "adjust state on prop change"
  // pattern), not in an effect. Presence decides in its own layout effect, which runs before any
  // effect of this component, so the class must already be in the DOM that render commits.
  // `useCloseSource`'s capture-phase keydown listener (08-04) has run by then.
  const [instantClose, setInstantClose] = useState(false);
  const [latchedOpen, setLatchedOpen] = useState(open);
  if (latchedOpen !== open) {
    setLatchedOpen(open);
    setInstantClose(!open && closeSource() === 'keyboard');
  }
  // 13-22: 'closing' while the release-to-close animation runs, so a re-grab mid-close tracks the
  // pointer 1:1 from the panel's on-screen position instead of Motion's elastic pulling it back
  // toward rest (see dragElasticFor). Reset whenever the sheet opens.
  const [dragPhase, setDragPhase] = useState<SheetDragPhase>('resting');

  // 08-UI-SPEC.md §7.2's durations table: "Sheet entry: translateX + spring: SPRING.drawer". Radix
  // mounts the outer `DialogPrimitive.Content` already open (no entry keyframe there, 14-26), so
  // this small settle-in on the drag surface is the entry motion SPRING.drawer governs. Imperative (`animate()` in an effect), not the declarative
  // `animate` prop -- a persistent declarative target on `x` is exactly what fought the
  // momentum-handoff animation in `handleDragEnd` (see the comment on `x` above).
  useEffect(() => {
    if (open) {
      setDragPhase('resting');
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
    const release = { offsetX: info.offset.x, velocityX: info.velocity.x, panelX: x.get() };
    if (decidesToClose(release, panelWidthPx)) {
      // Brief §7.4 steps 7-8: project momentum forward and hand its velocity off as the closing
      // spring's own initial velocity -- SPRING.momentum (UI-SPEC's own "only when the gesture
      // itself carried momentum" comment) is the one case that constant exists for. The outer
      // `DialogPrimitive.Content`'s exit animation (14-26) still governs when Radix removes it;
      // `onOpenChange(false)` is only called once this handoff animation finishes, so the two
      // never race (the outer slide then runs off-screen while the overlay fades).
      //
      // The velocity is clamped (handoffVelocity): a near-zero time between the last two pointer
      // samples can produce a non-finite value that leaves the spring's promise never resolving.
      setDragPhase('closing');
      const closingSpring = toMotionSpring(SPRING.momentum, { velocity: handoffVelocity(info.velocity.x) });
      void animateMotionValue(x, panelWidthPx, closingSpring).then(() => {
        onOpenChange(false);
      });
    } else {
      // Released without crossing the close threshold -- spring back to rest. Critically damped,
      // no overshoot (SPRING.default's own comment): this is deliberately not SPRING.momentum,
      // per UI-SPEC's token table reserving that spring for a release that actually carries the
      // gesture through to a close.
      setDragPhase('resting');
      void animateMotionValue(x, 0, toMotionSpring(SPRING.default));
    }
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(OVERLAY_CLASSES, instantClose && INSTANT_CLOSE_CLASS)}
          data-sheet-overlay=""
        />
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
              // open/closed position and exit animation, this inner surface owns the live gesture
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
              dragElastic={dragElasticFor(dragPhase)}
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
