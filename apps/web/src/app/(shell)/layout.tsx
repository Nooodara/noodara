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
import { useEffect, useState, type ReactNode } from 'react';
import { TooltipProvider } from '@noodara/ui';
import { Sidebar } from '../../components/Sidebar';
import { requireSession } from '../../lib/require-session';
import { ShellContext, type ShellContextValue } from '../../lib/shell-context';
import { useServerEvents } from '../../lib/use-server-events';

export default function ShellLayout({ children }: { readonly children: ReactNode }) {
  const serverEvents = useServerEvents();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // T-5-53: the shell's own session guard, run once on mount -- see require-session.ts for why
  // this is UX only and never the real authorization boundary.
  useEffect(() => {
    void requireSession();
  }, []);

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
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-sm focus:bg-accent focus:px-4 focus:py-2 focus:text-callout focus:font-medium focus:text-on-accent"
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
        </div>
      </TooltipProvider>
    </ShellContext.Provider>
  );
}
