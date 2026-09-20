'use client';

// The `(shell)` route-group's own App Router error boundary (05-28-PLAN.md Task 3, T-5G-28-02/
// T-5G-28-03). Next.js requires a Client Component receiving `{ error, reset }` here -- an
// uncaught render error anywhere inside this route group (a screen dereferencing something an
// environment condition made unavailable, a bug in a future plan, etc.) lands here instead of a
// blank page or Next's dev-only error overlay.
//
// `error` is deliberately never read beyond its required type position: 05-UI-SPEC.md SS10 bans
// echoing raw server/runtime output to the user, and an error boundary is exactly the place a
// stack trace or a `digest` could otherwise leak. Composed from `@noodara/ui` primitives only
// (EmptyState -- the existing "title, one sentence, one action" language this app already uses
// for a whole-screen state, e.g. ServerList.tsx's own error Banner for a narrower in-page failure)
// -- no new hex/rgb literal, no new component.
import { EmptyState } from '@noodara/ui';

export interface ShellErrorProps {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}

export default function ShellError({ reset }: ShellErrorProps) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-6">
      <EmptyState
        data-testid="shell-error-boundary"
        title="Something went wrong"
        body="This screen ran into a problem. Try again, and if it keeps happening, check the server logs."
        action={{ label: 'Try again', onClick: reset }}
      />
    </div>
  );
}
