'use client';

// The shell's fixed sign-out affordance (AUTH-03 "desde cualquier pantalla", T-5-51). Closes the
// shared `EventSource` first -- client-side, immediately -- then posts the real sign-out endpoint,
// then navigates to `/login`. Waiting for the server's own heartbeat to notice a revoked session
// would leave the stream visibly "connected" for up to the heartbeat interval after the user has
// already signed out; closing it here is the client-side complement to that server-side
// revalidation (apps/control-plane/src/routes/events.ts's heartbeat).
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
      data-testid="shell-sign-out"
      onClick={() => {
        void handleSignOut();
      }}
    >
      Sign out
    </Button>
  );
}
