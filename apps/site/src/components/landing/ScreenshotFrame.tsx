// 10-09-PLAN.md Task 2 (D-17, T-10-05). A flat, theme-following capture: hairline border, --r-lg
// radius, no window chrome, no drop elevation. Server component -- no Next.js image optimisation
// component (10-RESEARCH.md anti-pattern for a static-export site with no image optimisation
// server), plain <img> only, so build only ever copies bytes from docs/ui/approved rather than
// re-processing them.
//
// Renders BOTH the light and dark capture at once; global.css's `.site-shot-light`/
// `.site-shot-dark` rules (keyed off `html[data-theme]`, not `prefers-color-scheme` alone --
// D-17's own note on the site's explicit toggle overriding the OS preference) pick which one is
// visible. The dark image is `alt=""` + `aria-hidden` so a screen reader announces exactly one
// image, not two of the same screen.
import { assetPath } from '../../lib/build-info';
import type { ApprovedScreen } from '../../lib/site-facts';

export interface ScreenshotFrameProps {
  readonly screen: ApprovedScreen;
  readonly alt: string;
  readonly loading?: 'eager' | 'lazy';
  readonly caption?: string;
}

const CAPTURE_WIDTH = 1280;
const CAPTURE_HEIGHT = 900;

export function ScreenshotFrame({ screen, alt, loading = 'lazy', caption }: ScreenshotFrameProps) {
  return (
    <figure className="overflow-hidden rounded-lg border border-hairline">
      <img
        className="site-shot-light block w-full"
        src={assetPath(`/screenshots/${screen}-light.png`)}
        alt={alt}
        width={CAPTURE_WIDTH}
        height={CAPTURE_HEIGHT}
        loading={loading}
        decoding="async"
      />
      <img
        className="site-shot-dark block w-full"
        src={assetPath(`/screenshots/${screen}-dark.png`)}
        alt=""
        aria-hidden="true"
        width={CAPTURE_WIDTH}
        height={CAPTURE_HEIGHT}
        loading={loading}
        decoding="async"
      />
      {caption === undefined ? null : (
        <figcaption className="p-2 text-caption text-ink-secondary">{caption}</figcaption>
      )}
    </figure>
  );
}
