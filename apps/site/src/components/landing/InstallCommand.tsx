'use client';

// 10-09-PLAN.md Task 2 (D-01, T-10-12). The landing's one copyable install command -- the exact
// string site-facts.ts asserts against install.sh/README, with the "download, read, run"
// alternative (10-08's install.mdx §Install without piping to a shell) linked next to it so a
// visitor never has to trust a piped-to-shell command alone.
//
// A local TooltipProvider (not the app-wide one -- apps/site has none) so CopyButton's "Copied"
// confirmation tooltip has an ancestor, matching packages/ui/src/testing/render.tsx's own
// per-mount-site pattern for a component that needs exactly one.
import { CopyButton, TooltipProvider } from '@noodara/ui';
import { INSTALL_COMMAND } from '../../lib/site-facts';

const INSTALL_WITHOUT_PIPING_HREF = '/docs/getting-started/install#install-without-piping-to-a-shell';

export function InstallCommand() {
  return (
    <TooltipProvider>
      <div className="rounded-md border border-hairline bg-surface-2 p-4">
        <div className="flex items-start justify-between gap-4">
          <code className="block flex-1 overflow-x-auto whitespace-pre text-mono font-normal text-ink">
            {INSTALL_COMMAND}
          </code>
          <CopyButton value={INSTALL_COMMAND} label="Copy install command" />
        </div>
        <a
          href={INSTALL_WITHOUT_PIPING_HREF}
          className="mt-2 inline-block text-caption text-accent-text underline-offset-4 hover:underline"
        >
          Download, read, run
        </a>
      </div>
    </TooltipProvider>
  );
}
