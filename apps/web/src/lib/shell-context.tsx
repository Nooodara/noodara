'use client';

// The one context every shell component (Sidebar, Toolbar, SignOutButton, StreamStatus) and every
// future screen reads the shared SSE stream / mobile-nav state from. Split out of
// `apps/web/src/app/(shell)/layout.tsx` into its own module (rather than defined inline there) so
// `Sidebar.tsx` -> `SignOutButton.tsx` -> (context) and `Toolbar.tsx` -> (context) never import
// back into the route-group layout file itself -- a plain sibling import, not an import cycle
// through the file Next.js treats specially.
import { createContext, useContext } from 'react';
import type { DeployStreamApi, UseServerEventsResult } from './use-server-events';

/** The deploy-engine members are optional so a screen that only reads servers (and its test
 *  fixture) need not provide them; `useDeployStream` requires them. The shell layout always
 *  provides the full `useServerEvents()` result. */
export interface ShellContextValue
  extends Omit<UseServerEventsResult, keyof DeployStreamApi>,
    Partial<DeployStreamApi> {
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

/** The shell's deploy-engine stream (13-08): service/deployment events, per-deployment log
 *  subscriptions and the resync hook `useSyncedCollection` needs. */
export function useDeployStream(): DeployStreamApi & Pick<UseServerEventsResult, 'registerResync' | 'connected'> {
  const value = useShellContext();
  const { subscribeDeploy, subscribeDeploymentLog, registerResync, connected } = value;
  if (subscribeDeploy === undefined || subscribeDeploymentLog === undefined) {
    throw new Error('useDeployStream requires the shell layout to provide the deploy-engine stream');
  }
  return { subscribeDeploy, subscribeDeploymentLog, registerResync, connected };
}
