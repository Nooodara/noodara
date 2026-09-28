'use client';

// 10-11-PLAN.md Task 2 (D-15, UI-SPEC Layout/Accessibility contracts). Sticky landing/docs header:
// wordmark linking home, "Docs"/"GitHub" nav links (44px hit areas, focus-visible ring inherited
// from the app-wide link/button rule), and the theme toggle (10-02's SiteThemeToggle). Solid
// `--canvas` background with a 1px `--hairline` bottom border only -- flat, no blurred-behind
// effect (that budget is already spent elsewhere) and no drop elevation.
//
// `'use client'` (same reason apps/site/src/components/DocsNavTitle.tsx isolates its own Lockup
// import, 10-05-PLAN.md): `@noodara/ui`'s barrel re-exports several hook-using components with no
// `'use client'` directive of their own, so any Server Component importing `Lockup` from it pulls
// that whole graph in -- this file is composed straight into Landing.tsx (a Server Component), so
// the boundary has to live here.
import { Lockup } from '@noodara/ui';
import { SiteThemeToggle } from '../SiteThemeToggle';
import { GITHUB_URL } from '../../lib/site-facts';

const NAV_LINK_CLASSES =
  'inline-flex h-11 items-center px-2 text-body font-normal text-ink-secondary ' +
  'outline-none transition-[color] duration-[var(--duration-micro)] ease-[var(--ease-standard)] ' +
  'hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-10 border-b border-hairline bg-canvas">
      <div className="mx-auto flex h-16 max-w-[1120px] items-center justify-between px-6 min-[900px]:px-8">
        <a
          href="/"
          className="inline-flex h-11 items-center text-ink outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <Lockup title="Noodara" height={24} />
        </a>
        <nav className="flex items-center gap-2">
          <a href="/docs" className={NAV_LINK_CLASSES}>
            Docs
          </a>
          <a href={GITHUB_URL} rel="noopener noreferrer" className={NAV_LINK_CLASSES}>
            GitHub
          </a>
          <SiteThemeToggle />
        </nav>
      </div>
    </header>
  );
}
