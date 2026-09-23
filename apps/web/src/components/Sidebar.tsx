'use client';

// The shell's sidebar (UI-01, 05-UI-SPEC.md SS1) -- exactly three entity items, no v0.2+
// placeholder of any kind (CLAUDE.md SS8), plus a bottom cluster (theme toggle, then sign out)
// available from every authenticated screen (AUTH-03). Three fixed breakpoints: >=1280px shows
// labels, 900-1279px collapses to a 64px icon rail with tooltip labels on hover/focus, and below
// 900px this renders as a bottom sheet controlled by the toolbar's own menu button
// (`toggleMobileNav`, apps/web/src/lib/shell-context.tsx) rather than any state this component
// owns itself.
import { History, Server, Settings } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn, Tooltip } from '@noodara/ui';
import { Lockup, Logo, ThemeToggle } from '@noodara/ui';
import { SignOutButton } from './SignOutButton';

export interface SidebarProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

const ITEM_CLASSES =
  'flex h-11 items-center gap-3 rounded-sm px-3 text-callout font-medium text-ink-secondary hover:bg-surface-2';
const ACTIVE_ITEM_CLASSES = 'bg-accent-soft text-ink';
const LABEL_CLASSES = 'hidden min-[1280px]:inline';
const ICON_PROPS = { 'aria-hidden': true, size: 20, strokeWidth: 1.5 } as const;
// The brand slot (BRAND-02, D-04): the monogram alone in the 64px rail, the horizontal lockup in
// the expanded sidebar, and NO mark at all in the below-900px bottom sheet -- the sheet is a
// temporary navigation overlay, not the product's chrome. Both marks are always in the DOM and one
// is hidden per breakpoint, riding the same two thresholds the nav items already use
// (`min-[900px]` for the rail, `min-[1280px]` for the expanded state, inverted here exactly as
// LABEL_CLASSES inverts them). Height 44px (`h-11`) and `px-3` line the mark up with the nav items
// above the 8px grid; `text-ink` is what the mark's own `currentColor` inherits -- never the
// accent utility class, since the single action colour is reserved for actions and states (D-09).
// (Named descriptively rather than literally, following 07-03's own precedent, so this plan's
// "no second brand colour anywhere in this file" grep stays exact.)
const BRAND_RAIL_CLASSES = 'mb-3 hidden h-11 items-center px-3 text-ink min-[900px]:flex min-[1280px]:hidden';
const BRAND_EXPANDED_CLASSES = 'mb-3 hidden h-11 items-center px-3 text-ink min-[1280px]:flex';

export function Sidebar({ open, onClose }: SidebarProps) {
  const pathname = usePathname();
  const isActive = (href: string): boolean => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <>
      {open ? (
        // Mobile scrim -- closing the bottom sheet on an outside tap/click, hidden from >=900px
        // where the sidebar is never a sheet.
        <div
          aria-hidden="true"
          data-testid="shell-sidebar-scrim"
          onClick={onClose}
          className="fixed inset-0 z-40 bg-black/40 min-[900px]:hidden"
        />
      ) : null}
      <nav
        aria-label="Primary"
        data-testid="shell-sidebar"
        className={cn(
          'fixed inset-x-0 bottom-0 z-50 flex-col gap-1 border-t border-hairline bg-surface-1 p-4',
          'min-[900px]:static min-[900px]:inset-auto min-[900px]:z-auto min-[900px]:h-screen min-[900px]:w-16 min-[900px]:shrink-0 min-[900px]:border-r min-[900px]:border-t-0 min-[900px]:p-3',
          'min-[1280px]:w-60',
          open ? 'flex' : 'hidden min-[900px]:flex',
        )}
      >
        <div className={BRAND_RAIL_CLASSES}>
          <Logo title="Noodara" size={24} data-testid="brand-monogram" />
        </div>
        <div className={BRAND_EXPANDED_CLASSES}>
          <Lockup title="Noodara" height={20} data-testid="brand-lockup" />
        </div>
        <ul className="flex flex-col gap-1">
          <li>
            <Tooltip content="Servers">
              <Link
                href="/servers"
                aria-label="Servers"
                aria-current={isActive('/servers') ? 'page' : undefined}
                onClick={onClose}
                className={cn(ITEM_CLASSES, isActive('/servers') ? ACTIVE_ITEM_CLASSES : '')}
              >
                <Server {...ICON_PROPS} />
                <span className={LABEL_CLASSES}>Servers</span>
              </Link>
            </Tooltip>
          </li>
          <li>
            <Tooltip content="Activity">
              <Link
                href="/activity"
                aria-label="Activity"
                aria-current={isActive('/activity') ? 'page' : undefined}
                onClick={onClose}
                className={cn(ITEM_CLASSES, isActive('/activity') ? ACTIVE_ITEM_CLASSES : '')}
              >
                <History {...ICON_PROPS} />
                <span className={LABEL_CLASSES}>Activity</span>
              </Link>
            </Tooltip>
          </li>
          <li>
            <Tooltip content="Settings">
              <Link
                href="/settings"
                aria-label="Settings"
                aria-current={isActive('/settings') ? 'page' : undefined}
                onClick={onClose}
                className={cn(ITEM_CLASSES, isActive('/settings') ? ACTIVE_ITEM_CLASSES : '')}
              >
                <Settings {...ICON_PROPS} />
                <span className={LABEL_CLASSES}>Settings</span>
              </Link>
            </Tooltip>
          </li>
        </ul>
        <div className="mt-auto flex flex-col gap-1 border-t border-hairline pt-3">
          <ThemeToggle data-testid="shell-theme-toggle" />
          <SignOutButton />
        </div>
      </nav>
    </>
  );
}
