'use client';

// The authenticated shell route-group layout (UI-01, 05-UI-SPEC.md SS1). `/setup` and `/login`
// render outside this group entirely -- this is where every screen this phase still has to build
// (Servers, Activity, Settings, server detail) will mount, sharing exactly one sidebar, one
// stream, and one keyboard path.
//
// A client-boundary layout (not a Server Component): `useServerEvents` opens a browser-only
// `EventSource`, so this whole subtree has to be a Client Component from the route-group root
// down. `ShellContext` (apps/web/src/lib/shell-context.tsx) is instantiated exactly once, here --
// every descendant (`Sidebar`, `Toolbar`, `SignOutButton`, `StreamStatus`, and every future
// screen) reads the shared stream and the mobile-nav toggle from that one context, never a second
// `useServerEvents()` call of its own.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn, Sheet, TooltipProvider } from '@noodara/ui';
import { Sidebar } from '../../components/Sidebar';
import { requireSession } from '../../lib/require-session';
import { ShellContext, type ShellContextValue } from '../../lib/shell-context';
import { useServerEvents } from '../../lib/use-server-events';

// 08-09-PLAN.md Task 1 (D-08): the `@inspector` slot's column-vs-Sheet choice is a client-side
// breakpoint read -- the parallel route itself resolves server-side per request and knows nothing
// about the viewport. `false` is the SSR-safe/first-client-render default (matches
// ThemeToggle.tsx's own "environment-independent default, adopted a moment later" pattern): the
// only visible effect of a wrong-for-one-frame default here is which presentation a *populated*
// slot uses, and `default.tsx` returning `null` means the empty slot this phase actually ships is
// unaffected by this value either way.
const INSPECTOR_COLUMN_QUERY = '(min-width: 1280px)';

function useIsDesktopInspector(): boolean {
  const [isDesktop, setIsDesktop] = useState(false);

  useEffect(() => {
    const mediaQueryList = window.matchMedia(INSPECTOR_COLUMN_QUERY);
    setIsDesktop(mediaQueryList.matches);
    const handleChange = (event: MediaQueryListEvent) => {
      setIsDesktop(event.matches);
    };
    mediaQueryList.addEventListener('change', handleChange);
    return () => {
      mediaQueryList.removeEventListener('change', handleChange);
    };
  }, []);

  return isDesktop;
}

export default function ShellLayout({
  children,
  inspector,
}: {
  readonly children: ReactNode;
  readonly inspector: ReactNode;
}) {
  const serverEvents = useServerEvents();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const isDesktopInspector = useIsDesktopInspector();
  // `default.tsx` returns `null` -- this is `false` for every route until Phase 13 nests a real
  // `@inspector` route under `(shell)`. Kept as its own named boolean (rather than inlining
  // `inspector !== null` at each call site) so the "is there content" question and the "which
  // breakpoint" question stay independently readable.
  const hasInspectorContent = inspector !== null;

  // T-5-53: the shell's own session guard, run once on mount -- see require-session.ts for why
  // this is UX only and never the real authorization boundary.
  useEffect(() => {
    void requireSession();
  }, []);

  // WR-B-10 (05-35-PLAN.md Task 3): the mount-time check above cannot see a session that goes bad
  // later. The shared SSE stream's own `connected` state is the natural post-mount signal
  // require-session.ts's own header describes: the heartbeat closes the stream server-side the
  // moment it finds no session (apps/control-plane/src/routes/events.ts), the browser's own
  // reconnect attempt then gets a real 401, and `use-server-events.ts` flips `connected` to
  // `false` for that. Re-running `requireSession()` on every "was open, now isn't" transition
  // costs one cheap, already-guarded fetch and fails open on anything but a genuine 401 --
  // `requireSession` itself never redirects on `NETWORK_ERROR`, so an ordinary reconnect blip
  // (which also flips `connected` to `false`) never signs anyone out. No polling interval is
  // added: this only ever fires in response to a state change `useServerEvents` already computes.
  //
  // A drop this tab asked for is not a signal: `SignOutButton` closes the stream itself right
  // before posting `/api/auth/sign-out`, and re-running the guard on that drop races its own
  // `router.push('/login')` against the guard's `/login?redirect=/servers` full navigation --
  // on a slow machine (GitHub's runners) the guard won and sign-out landed on the wrong URL.
  // `closedByCaller` is exactly that distinction, computed by the hook that did the closing.
  const wasConnectedRef = useRef(false);
  useEffect(() => {
    if (serverEvents.connected) {
      wasConnectedRef.current = true;
      return;
    }
    if (wasConnectedRef.current) {
      wasConnectedRef.current = false;
      if (!serverEvents.closedByCaller) {
        void requireSession();
      }
    }
  }, [serverEvents.connected, serverEvents.closedByCaller]);

  const contextValue: ShellContextValue = {
    ...serverEvents,
    mobileNavOpen,
    toggleMobileNav: () => {
      setMobileNavOpen((open) => !open);
    },
    closeMobileNav: () => {
      setMobileNavOpen(false);
    },
  };

  return (
    <ShellContext.Provider value={contextValue}>
      <TooltipProvider>
        {/* Visually hidden until focused -- the very first tab stop (05-UI-SPEC.md SS1's
            six-step focus order, step 1). No suppressed focus outline anywhere: globals.css's
            `:focus-visible` rule already gives this (and every other interactive element in
            this app) a visible ring with no per-component override needed. */}
        <a
          href="#shell-main"
          // focus:bg-accent-fill, not focus:bg-accent (05-33 continuation D2, 2026-09-20) -- this
          // fill carries focus:text-on-accent, same rationale as Button.tsx's primary variant.
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-sm focus:bg-accent-fill focus:px-4 focus:py-2 focus:text-callout focus:font-medium focus:text-on-accent"
        >
          Skip to content
        </a>
        <div className="flex min-h-screen bg-canvas">
          <Sidebar
            open={mobileNavOpen}
            onClose={() => {
              setMobileNavOpen(false);
            }}
          />
          <main id="shell-main" tabIndex={-1} className="min-w-0 flex-1">
            {children}
          </main>
          {/* 08-09-PLAN.md Task 1 (D-08): the third shell panel, empty until Phase 13 nests a real
              `@inspector` route. `w-0 border-0` unconditionally is what makes the empty slot cost
              nothing at every viewport (§9 #19) -- the `min-[1280px]:w-[384px]` column width is
              only ever added to the class list once there is real content to show, so a future
              regression that always reserves the 384px column (even while empty) fails the
              zero-width E2E assertion below instead of shipping unnoticed. No border, no shadow,
              no background of its own, and no blocking overlay of any kind (§7.7). */}
          <aside
            data-testid="shell-inspector-slot"
            className={cn('w-0 border-0', hasInspectorContent ? 'min-[1280px]:w-[384px]' : null)}
          >
            {hasInspectorContent && isDesktopInspector ? inspector : null}
          </aside>
        </div>
        {/* Below 1280px a populated slot presents as a lateral Sheet instead of a column (D-08).
            Radix's `Dialog.Portal` renders nothing at all while `open` is `false`, so this branch
            is inert -- no title, no DOM, no artifact -- for every route in this phase, since
            `hasInspectorContent` is always `false` until Phase 13 populates the slot. Phase 13
            owns the real `onOpenChange` dismissal behaviour for its own content; this plan ships
            only the presentation choice (column vs. Sheet), never any stand-in copy of its own. */}
        {hasInspectorContent && !isDesktopInspector ? (
          <Sheet
            open={hasInspectorContent}
            onOpenChange={() => undefined}
            title="Inspector"
            data-testid="shell-inspector-sheet"
          >
            {inspector}
          </Sheet>
        ) : null}
      </TooltipProvider>
    </ShellContext.Provider>
  );
}
