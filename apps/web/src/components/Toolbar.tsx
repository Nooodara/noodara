'use client';

// The reusable 52px sticky toolbar every screen inside the shell renders at the top of its own
// content (05-UI-SPEC.md SS1 "Toolbar"). Not auto-rendered by `(shell)/layout.tsx` -- each screen
// (starting with Plan 05-13) imports and renders its own `<Toolbar>` with its own title/actions,
// exactly like `AuthCard` is each unauthenticated screen's own chrome rather than the root
// layout's.
//
// `primaryAction`/`secondaryActions` are plain optional nodes (never arrays): the skill's
// "un botón primario como máximo" rule is enforced by this prop shape itself, not by convention.
// `StreamStatus` renders from the shared shell context (`connected`), never a prop a screen has
// to thread through itself. Below 900px, and only when no `backLink` is given, this renders the
// hamburger-style menu button that opens the sidebar's bottom sheet (05-UI-SPEC.md SS1's
// responsive breakpoints) -- on server detail (a later plan), a present `backLink` takes that same
// slot instead, per that same spec section.
//
// 14-19: the bar is always one row. Below TOOLBAR_COMPACT_MAX_WIDTH (measured on the bar itself,
// so the sidebar and inspector count) it goes compact, the ServiceToolbar pattern from 14-13: the
// back link becomes a 44 px arrow, the stream status moves under the title, the title block keeps
// at least 12 characters of its own font, and slots given as functions get the layout so a screen
// can move its secondary actions into a RowMenu.
import { Menu } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { cn } from '@noodara/ui';
import { StreamStatus } from './StreamStatus';
import { useShellContext } from '../lib/shell-context';

export interface ToolbarBackLink {
  readonly href: string;
  readonly label: string;
}

export type ToolbarLayout = 'compact' | 'full';

/** A slot's content, or a function of the measured layout. */
export type ToolbarSlot = ReactNode | ((layout: ToolbarLayout) => ReactNode);

export interface ToolbarProps {
  readonly title: string;
  readonly backLink?: ToolbarBackLink;
  readonly primaryAction?: ToolbarSlot;
  readonly secondaryActions?: ToolbarSlot;
}

/** Below this bar width (px) the full row (project toolbar: back link, a 12-character title,
 *  Edit, Unarchive, Delete, New environment) no longer fits. */
export const TOOLBAR_COMPACT_MAX_WIDTH = 800;

/** 0 means not laid out yet (first render, jsdom): keep the full layout rather than guess. */
export function toolbarLayout(width: number): ToolbarLayout {
  return width > 0 && width < TOOLBAR_COMPACT_MAX_WIDTH ? 'compact' : 'full';
}

/** The layout for the element's current width, measured before paint and on every resize. */
function useToolbarLayout(ref: RefObject<HTMLElement | null>): ToolbarLayout {
  const [layout, setLayout] = useState<ToolbarLayout>('full');
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return undefined;
    const measure = (): void => {
      setLayout(toolbarLayout(element.getBoundingClientRect().width));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [ref]);
  return layout;
}

function renderSlot(slot: ToolbarSlot, layout: ToolbarLayout): ReactNode {
  return typeof slot === 'function' ? slot(layout) : slot;
}

/** "← Projects" -> "Projects": the arrow is decoration, the name is where the link goes. */
function backLinkDestination(label: string): string {
  return label.replace(/^←\s*/, '');
}

/** Titles past this many characters get the 12ch floor in the full layout too. */
const TITLE_FLOOR_CHARS = 12;

// 08-10-PLAN.md Task 1 (UI-07/D-03, 08-UI-SPEC.md SS2.2): the permanent `border-b border-hairline`
// this root used to carry unconditionally is now a scroll-position-driven toggle -- transparent at
// the very top of the page, the real hairline the instant content has scrolled under this sticky
// chrome. A plain passive `scroll` listener on `window` (this app's own scroll container: `main`
// in `(shell)/layout.tsx` carries no `overflow-y-auto` of its own, so the window/document is what
// actually scrolls here), read once synchronously on mount to cover the back-forward-cache case
// (a page can mount already scrolled), cleaned up on unmount (T-08-29: no leaked listener, no
// per-frame layout read -- `window.scrollY` is a cached layout value, not a forced reflow). This
// scroll state is this component's own local concern: it is never threaded into `ShellContext`,
// which stays exactly the shape 08-01 gave it.
function useScrolled(): boolean {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    function handleScroll(): void {
      setScrolled(window.scrollY > 0);
    }
    handleScroll();
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', handleScroll);
    };
  }, []);

  return scrolled;
}

// 08-10-PLAN.md Task 2 (UI-10, 08-UI-SPEC.md SS10): the same three arbitrary-variant forms
// `packages/ui/src/Sheet.tsx` established (08-06) -- one consistent expression across the repo,
// not a second style. `prefers-reduced-transparency: reduce` drops the toolbar's translucent
// `bg-surface-1/90 backdrop-blur` to a fully solid `bg-surface-1` with `backdrop-filter: none`
// (the arbitrary-property form: Tailwind composes backdrop-blur into a shorthand, so setting only
// the blur utility to `none` would not by itself clear the underlying `backdrop-filter` property).
// This is the toolbar's own budget note: it stays the page's one permanent `backdrop-filter`
// (D-03) -- dropping it here under reduced transparency is what keeps the worst case at three
// simultaneous translucent surfaces (Toolbar + ServerDetailToolbar + Sheet) rather than four, per
// `scripts/check-ui-safety.mjs`'s existing "at most three" gate. `prefers-contrast: more` pushes
// the background fully opaque too and, once scrolled, swaps the hairline for the strong token --
// the unscrolled state stays transparent even under contrast-more, since there is deliberately no
// permanent line to strengthen at the very top of the page.
const BASE_CLASSES = cn(
  'sticky top-0 z-30 flex min-h-[52px] flex-nowrap items-center border-b bg-surface-1/90 px-4 py-1 backdrop-blur',
  // 08-11-PLAN.md Task 3 round 1 (deferred-items.md, P17 theme flicker): the whole `transition-colors`
  // form bundles background-color into the animation, so a theme switch fades this toolbar's own
  // background in over `--duration-panel` while every other surface on the page snaps instantly --
  // a stray grey/near-white band across the toolbar, visible in the dark-theme review captures.
  // Only the scroll-edge hairline is meant to animate here; `transition-[border-color]` (the same
  // single-property arbitrary form Input.tsx/Textarea.tsx already use) scopes the animation to
  // exactly that.
  'motion-safe:transition-[border-color] motion-safe:duration-[var(--duration-panel)] motion-safe:ease-[var(--ease-out)]',
  '[@media(prefers-reduced-transparency:reduce)]:bg-surface-1',
  '[@media(prefers-reduced-transparency:reduce)]:[backdrop-filter:none]',
  'contrast-more:bg-surface-1',
);

const FOCUS_RING = 'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

export function Toolbar({ title, backLink, primaryAction, secondaryActions }: ToolbarProps) {
  const { connected, toggleMobileNav } = useShellContext();
  const scrolled = useScrolled();
  const toolbarRef = useRef<HTMLDivElement>(null);
  const layout = useToolbarLayout(toolbarRef);
  const compact = layout === 'compact';

  return (
    <div
      ref={toolbarRef}
      data-testid="shell-toolbar"
      data-layout={layout}
      className={cn(
        BASE_CLASSES,
        compact ? 'gap-2' : 'gap-3',
        scrolled ? 'border-hairline contrast-more:border-hairline-strong' : 'border-transparent',
      )}
    >
      {backLink === undefined ? (
        <button
          type="button"
          aria-label="Open navigation"
          data-testid="shell-menu-button"
          onClick={toggleMobileNav}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-sm text-ink-secondary hover:bg-surface-2 min-[900px]:hidden"
        >
          <Menu aria-hidden="true" size={20} strokeWidth={1.5} />
        </button>
      ) : compact ? (
        <Link
          href={backLink.href}
          aria-label={`Back to ${backLinkDestination(backLink.label)}`}
          className={cn(
            '-ml-3 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-sm text-headline text-ink-secondary hover:text-ink',
            FOCUS_RING,
          )}
        >
          <span aria-hidden="true">←</span>
        </Link>
      ) : (
        <Link href={backLink.href} className="shrink-0 whitespace-nowrap text-callout text-ink-secondary hover:text-ink">
          {backLink.label}
        </Link>
      )}
      {/* ch is relative to this block's font (the title's), so 12ch is 12 title characters. */}
      <div
        data-testid="shell-toolbar-title"
        className={cn(
          'flex flex-1 text-title',
          compact ? 'min-w-[12ch] flex-col items-start gap-0.5' : 'min-w-0 items-center',
        )}
      >
        <h1
          title={title}
          className={cn(
            'truncate text-title font-semibold text-ink',
            compact ? 'w-full min-w-0' : title.length > TITLE_FLOOR_CHARS && 'min-w-[12ch]',
          )}
        >
          {title}
        </h1>
        {compact ? <StreamStatus connected={connected} /> : null}
      </div>
      {compact ? null : <StreamStatus connected={connected} />}
      <div
        data-testid="shell-toolbar-actions"
        className={cn('flex shrink-0 items-center whitespace-nowrap', compact ? 'gap-1' : 'gap-3')}
      >
        {renderSlot(secondaryActions, layout)}
        {renderSlot(primaryAction, layout)}
      </div>
    </div>
  );
}
