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
        </div>
      </TooltipProvider>
    </ShellContext.Provider>
  );
}
