// 10-05-PLAN.md Task 2 (DOCS-01, D-08, D-15, D-16). Fumadocs' own `DocsLayout` renders the
// sidebar (from `source.pageTree`, ordered by the five meta.json files) and the header. The nav
// title is the same `Lockup` SVG the app's own sidebar uses (D-16: no redrawn wordmark), the
// theme-switch slot is this site's own `SiteThemeToggle` (D-15: no `next-themes`, matches
// RESEARCH.md Pitfall 5's `.dark`+`[data-theme]` double-write), and `githubUrl`/no extra links
// keep the header free of any third-party widget (D-06/D-14: no GitHub star counter).
import type { ReactNode } from 'react';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { DocsNavTitle } from '../../components/DocsNavTitle';
import { SiteThemeToggle } from '../../components/SiteThemeToggle';
import { source } from '../../lib/source';

export default function DocsRootLayout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      tree={source.pageTree}
      nav={{ title: <DocsNavTitle />, url: '/' }}
      slots={{ themeSwitch: SiteThemeToggle }}
    >
      {children}
    </DocsLayout>
  );
}
