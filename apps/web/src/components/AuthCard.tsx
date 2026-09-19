import type { ReactNode } from 'react';

export interface AuthCardProps {
  readonly title: string;
  readonly children: ReactNode;
}

// The shared setup/login surface (05-UI-SPEC.md SS2.1/SS2.2): a centered 400px card on
// --surface-1 with --r-lg, rendered directly on --canvas -- no sidebar, no toolbar. Both screens
// render outside the authenticated shell (05-CONTEXT.md's "no shell" decision for setup/login), so
// this is the entire page chrome for /setup and /login; the authenticated shell Plan 05-12 builds
// is a separate route-group layout this component has nothing to do with.
export function AuthCard({ title, children }: AuthCardProps) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-4 py-8">
      <div className="flex w-full max-w-[400px] flex-col gap-5 rounded-lg bg-surface-1 p-8">
        <h1 className="text-title font-semibold text-ink">{title}</h1>
        {children}
      </div>
    </main>
  );
}
