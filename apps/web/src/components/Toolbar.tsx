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
import type { ReactNode } from 'react';
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

export function Toolbar({ title, backLink, primaryAction, secondaryActions }: ToolbarProps) {
  const { connected, toggleMobileNav } = useShellContext();

  return (
    <div
      data-testid="shell-toolbar"
      className="sticky top-0 z-30 flex h-[52px] items-center gap-3 border-b border-hairline bg-surface-1/90 px-4 backdrop-blur"
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
