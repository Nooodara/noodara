// 10-11-PLAN.md Task 2 (D-06, T-10-05), extended 10-12-PLAN.md Round 1 (D-02a/D-08), full page
// lists restored in the orchestrator's Round 1 review batch (item 6): each docs column previously
// showed one representative link only ("Getting started: Install"), which looked broken next to
// a heading implying a whole group. Now every column lists every real page of its D-08 group,
// read straight from meta.json + MDX frontmatter by `DOCS_NAV_GROUPS` (apps/site/src/lib/
// docs-nav.ts) -- never a hand-typed, driftable copy of the sidebar. Plus the original Project
// column (Docs/GitHub/license/version, unchanged text and links so the existing footer test keeps
// passing). Still no star count, no fetch, no third-party call (T-10-05's mitigation for the
// star-counter/privacy threat).
import { readBuildInfo } from '../../lib/build-info';
import { GITHUB_URL } from '../../lib/site-facts';
import { DOCS_NAV_GROUPS } from '../../lib/docs-nav';

const LINK_CLASSES =
  'text-body font-normal text-ink-secondary underline-offset-4 hover:text-ink hover:underline ' +
  'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

const GROUP_HEADING_CLASSES = 'text-label uppercase tracking-[0.04em] text-ink-tertiary';

export function SiteFooter() {
  const { license, version } = readBuildInfo();

  return (
    <footer className="border-t border-hairline bg-surface-1">
      <div className="mx-auto grid max-w-[1120px] grid-cols-2 gap-8 px-6 py-12 min-[900px]:grid-cols-5 min-[900px]:px-8">
        {DOCS_NAV_GROUPS.map((group) => (
          <div key={group.heading} className="flex flex-col gap-3">
            <p className={GROUP_HEADING_CLASSES}>{group.heading}</p>
            {group.links.map((link) => (
              <a key={link.href} href={link.href} className={LINK_CLASSES}>
                {link.label}
              </a>
            ))}
          </div>
        ))}
        <div className="col-span-2 flex flex-col gap-3 min-[900px]:col-span-1">
          <p className={GROUP_HEADING_CLASSES}>Project</p>
          <a href="/docs" className={LINK_CLASSES}>
            Docs
          </a>
          <a href={GITHUB_URL} rel="noopener noreferrer" className={LINK_CLASSES}>
            GitHub
          </a>
          <p className="text-caption font-normal text-ink-secondary">
            {license} · {version}
          </p>
        </div>
      </div>
    </footer>
  );
}
