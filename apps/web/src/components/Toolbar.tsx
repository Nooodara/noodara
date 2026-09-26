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
import { Menu } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { cn } from '@noodara/ui';
import { StreamStatus } from './StreamStatus';
import { useShellContext } from '../lib/shell-context';

export interface ToolbarBackLink {
  readonly href: string;
  readonly label: string;
}

export interface ToolbarProps {
  readonly title: string;
  readonly backLink?: ToolbarBackLink;
  readonly primaryAction?: ReactNode;
  readonly secondaryActions?: ReactNode;
}

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
  'sticky top-0 z-30 flex h-[52px] items-center gap-3 border-b bg-surface-1/90 px-4 backdrop-blur',
  'motion-safe:transition-colors motion-safe:duration-[var(--duration-panel)] motion-safe:ease-[var(--ease-out)]',
  '[@media(prefers-reduced-transparency:reduce)]:bg-surface-1',
  '[@media(prefers-reduced-transparency:reduce)]:[backdrop-filter:none]',
  'contrast-more:bg-surface-1',
);

export function Toolbar({ title, backLink, primaryAction, secondaryActions }: ToolbarProps) {
  const { connected, toggleMobileNav } = useShellContext();
  const scrolled = useScrolled();

  return (
    <div
      data-testid="shell-toolbar"
      className={cn(
        BASE_CLASSES,
        scrolled ? 'border-hairline contrast-more:border-hairline-strong' : 'border-transparent',
      )}
    >
      {backLink ? (
        <Link href={backLink.href} className="text-callout text-ink-secondary hover:text-ink">
          {backLink.label}
        </Link>
      ) : (
        <button
          type="button"
          aria-label="Open navigation"
          data-testid="shell-menu-button"
          onClick={toggleMobileNav}
          className="flex h-11 w-11 items-center justify-center rounded-sm text-ink-secondary hover:bg-surface-2 min-[900px]:hidden"
        >
          <Menu aria-hidden="true" size={20} strokeWidth={1.5} />
        </button>
      )}
      <h1 className="flex-1 truncate text-title font-semibold text-ink">{title}</h1>
      <StreamStatus connected={connected} />
      {secondaryActions}
      {primaryAction}
    </div>
  );
}
