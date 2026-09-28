// 10-11-PLAN.md Task 2 (D-06, T-10-05). The footer: Docs/GitHub links, the license and version
// read at build via readBuildInfo() -- never hand-typed -- and nothing else. No star count, no
// fetch, no third-party call (T-10-05's mitigation for the star-counter/privacy threat).
import { readBuildInfo } from '../../lib/build-info';
import { GITHUB_URL } from '../../lib/site-facts';

const LINK_CLASSES =
  'text-body font-normal text-ink-secondary underline-offset-4 hover:text-ink hover:underline ' +
  'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

export function SiteFooter() {
  const { license, version } = readBuildInfo();

  return (
    <footer className="border-t border-hairline bg-surface-1">
      <div className="mx-auto flex max-w-[1120px] flex-col gap-4 px-6 py-8 min-[900px]:flex-row min-[900px]:items-center min-[900px]:justify-between min-[900px]:px-8">
        <div className="flex items-center gap-6">
          <a href="/docs" className={LINK_CLASSES}>
            Docs
          </a>
          <a href={GITHUB_URL} rel="noopener noreferrer" className={LINK_CLASSES}>
            GitHub
          </a>
        </div>
        <p className="text-caption font-normal text-ink-secondary">
          {license} · {version}
        </p>
      </div>
    </footer>
  );
}
