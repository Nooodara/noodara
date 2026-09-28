'use client';

// 10-07-PLAN.md Task 2 (D-14, 10-UI-SPEC.md Copywriting + Typography). Cloudflare Pages serves
// this route's static output (`out/404.html`) for any unmatched path, so it is the one page every
// broken link lands on -- D-14 requires it still carry the Noodara identity, not a bare browser
// error. `'use client'`: the one `@noodara/ui` import this file needs (`Lockup`) comes from a
// barrel whose other exports use hooks with no `'use client'` directive of their own (same reason
// apps/site/src/components/DocsNavTitle.tsx isolates its own Lockup import, 10-05-PLAN.md).
//
// Layout mirrors apps/web/src/components/AuthCard.tsx: centered on --canvas, the lockup painted
// with currentColor via text-ink, no shadow, no illustration.
import Link from 'next/link';
import { Lockup } from '@noodara/ui';

export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-4 py-8">
      <div className="flex max-w-[440px] flex-col items-center gap-4 text-center">
        <div className="text-ink">
          <Lockup title="Noodara" height={32} data-testid="brand-lockup" />
        </div>
        <h1 className="text-title font-semibold text-ink">Page not found</h1>
        <p className="text-body text-ink-secondary">
          This page doesn&apos;t exist. Head back to the{' '}
          <Link href="/docs" className="text-accent-text hover:underline">
            docs
          </Link>{' '}
          or the{' '}
          <Link href="/" className="text-accent-text hover:underline">
            homepage
          </Link>
          .
        </p>
      </div>
    </main>
  );
}
