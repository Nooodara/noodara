// 10-12-PLAN.md Round 1 (D-02a). Closing CTA band: re-renders InstallCommand near the page end
// (D-01's install command now appears twice: hero + here) on its own surface step. Deliberately
// does not repeat "Read the docs"/"View on GitHub" -- those stay singular for the existing
// link-uniqueness tests and so the footer isn't a third repetition of the same nav.
import { InstallCommand } from './InstallCommand';

export function ClosingCta() {
  return (
    <div className="flex flex-col items-center gap-6 rounded-lg border border-hairline bg-surface-1 p-8 text-center">
      <h2 className="text-title font-semibold text-ink">Get started in one command</h2>
      <div className="w-full max-w-[560px]">
        <InstallCommand />
      </div>
    </div>
  );
}
