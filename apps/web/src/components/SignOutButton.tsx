'use client';

// The shell's fixed sign-out affordance (AUTH-03 "desde cualquier pantalla", T-5-51). Closes the
// shared `EventSource` first -- client-side, immediately -- then posts the real sign-out endpoint,
// then navigates to `/login`. Waiting for the server's own heartbeat to notice a revoked session
// would leave the stream visibly "connected" for up to the heartbeat interval after the user has
// already signed out; closing it here is the client-side complement to that server-side
// revalidation (apps/control-plane/src/routes/events.ts's heartbeat).
//
// 08-08-PLAN.md Task 2 (T-08-24): now rendered as the last row inside `AccountMenu`, never a
// second implementation of this sequence -- `AccountMenu` receives this component as an opaque
// `signOutSlot` and cannot substitute a different endpoint. `role="menuitem"` makes this the
// second (and last) node `use-floating-menu.ts`'s `[role="menuitem"]` arrow-key query finds inside
// the menu, alongside AccountMenu's own "Settings" row -- unchanged from any other menuitem in
// this codebase, the click-driven sign-out sequence below is exactly what fires on Enter/Space.
import { Button } from '@noodara/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiSend } from '../lib/api-client';
import { useShellContext } from '../lib/shell-context';

export function SignOutButton() {
  const router = useRouter();
  const { close } = useShellContext();
  const [signingOut, setSigningOut] = useState(false);

  async function handleSignOut(): Promise<void> {
    setSigningOut(true);
    close();
    await apiSend('POST', '/api/auth/sign-out');
    router.push('/login');
  }

  return (
    <Button
      variant="ghost"
      loading={signingOut}
      role="menuitem"
      data-testid="shell-account-menu-sign-out"
      onClick={() => {
        void handleSignOut();
      }}
    >
      Sign out
    </Button>
  );
}
