'use client';

// The one context every shell component (Sidebar, Toolbar, SignOutButton, StreamStatus) and every
// future screen reads the shared SSE stream / mobile-nav state from. Split out of
// `apps/web/src/app/(shell)/layout.tsx` into its own module (rather than defined inline there) so
// `Sidebar.tsx` -> `SignOutButton.tsx` -> (context) and `Toolbar.tsx` -> (context) never import
// back into the route-group layout file itself -- a plain sibling import, not an import cycle
// through the file Next.js treats specially.
import { createContext, useContext } from 'react';
import type { UseServerEventsResult } from './use-server-events';

export interface ShellContextValue extends UseServerEventsResult {
  readonly mobileNavOpen: boolean;
  readonly toggleMobileNav: () => void;
  readonly closeMobileNav: () => void;
}

export const ShellContext = createContext<ShellContextValue | null>(null);

/** Throws outside the shell so a misplaced import fails loudly in development rather than
 *  silently reading `undefined`. */
export function useShellContext(): ShellContextValue {
  const value = useContext(ShellContext);
  if (value === null) {
    throw new Error('useShellContext must be used within the authenticated shell layout');
  }
  return value;
}
