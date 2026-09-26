import type { CSSProperties, ReactNode } from 'react';
import { Lockup } from '@noodara/ui';

export interface AuthCardProps {
  readonly title: string;
  readonly children: ReactNode;
}

// The shared setup/login surface (05-UI-SPEC.md SS2.1/SS2.2): a centered 400px card on
// --surface-1 with --r-lg, rendered directly on --canvas -- no sidebar, no toolbar. Both screens
// render outside the authenticated shell (05-CONTEXT.md's "no shell" decision for setup/login), so
// this is the entire page chrome for /setup and /login; the authenticated shell Plan 05-12 builds
// is a separate route-group layout this component has nothing to do with.
//
// It also carries the brand slot for both unauthenticated screens (BRAND-02, D-04): the horizontal
// lockup sits above the heading, painted with `currentColor` through `text-ink` so one SVG serves
// light and dark with no theme branch, and the card's own `gap-5` supplies its spacing.
//
// D-09/D-11 (08-18-PLAN.md Task 1): the lockup's aperture focuses once on load, the same
// `[data-part="aperture"]` technique the Discovery Viewfinder ring uses (packages/ui/aperture.css).
// This is entirely declarative -- no mount effect, no interval, no loop: `--aperture-progress`
// rests at `1` (closed/sharp) always, and `data-entering`/`data-aperture-focus` key into
// aperture.css's own `@starting-style` rule for the value the property held before this element
// existed (`0`, open/blurred). The browser plays that one transition exactly once, on first paint,
// with no JS involved -- a mount effect would only be needed to *re-trigger* the animation, which
// D-11 explicitly forbids ("no loop").
const APERTURE_FOCUS_STYLE = { '--aperture-progress': 1 } as CSSProperties;

export function AuthCard({ title, children }: AuthCardProps) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-4 py-8">
      <div className="flex w-full max-w-[400px] flex-col gap-5 rounded-lg bg-surface-1 p-8">
        <div
          className="flex items-center text-ink"
          data-entering="true"
          data-aperture-focus="true"
          style={APERTURE_FOCUS_STYLE}
        >
          <Lockup title="Noodara" height={22} data-testid="brand-lockup" />
        </div>
        <h1 className="text-title font-semibold text-ink">{title}</h1>
        {children}
      </div>
    </main>
  );
}
