'use client';

// 10-11-PLAN.md Task 2 (D-01, D-18, T-10-04). The landing's hero: the one-shot aperture-focused
// lockup, the headline, one factual subline, the copyable install command, the two CTAs, and the
// real Servers capture. The aperture wrapper reproduces apps/web/src/components/AuthCard.tsx's
// own declarative attributes exactly (data-entering/data-aperture-focus/data-aperture-focused +
// `--aperture-progress: 1`) -- no JS, no loop, packages/ui/aperture.css supplies the transition
// and the reduced-motion fallback. The lockup's CSS height is overridden on the wrapped <svg>
// (32px mobile -> 40px at >=900px per the UI-SPEC layout contract) since Lockup itself takes only
// a fixed `height` prop with no responsive variant.
import type { CSSProperties } from 'react';
import { Lockup } from '@noodara/ui';
import { InstallCommand } from './InstallCommand';
import { ScreenshotFrame } from './ScreenshotFrame';
import { GITHUB_URL } from '../../lib/site-facts';

const APERTURE_FOCUS_STYLE = { '--aperture-progress': 1 } as CSSProperties;

const PRIMARY_CTA_CLASSES =
  'inline-flex min-h-11 items-center justify-center rounded-sm bg-accent-fill px-4 text-body font-semibold text-on-accent ' +
  'outline-none transition-[opacity] duration-[var(--duration-micro)] ease-[var(--ease-standard)] hover:opacity-90 ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

const SECONDARY_CTA_CLASSES =
  'inline-flex min-h-11 items-center justify-center rounded-sm border border-hairline px-4 text-body font-semibold text-ink ' +
  'outline-none transition-[opacity] duration-[var(--duration-micro)] ease-[var(--ease-standard)] hover:bg-surface-2 ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

export function Hero() {
  return (
    <section className="flex flex-col gap-6">
      <div
        className="flex items-center text-ink [&>svg]:h-8 [&>svg]:w-auto min-[900px]:[&>svg]:h-10"
        data-entering="true"
        data-aperture-focus="true"
        data-aperture-focused="true"
        style={APERTURE_FOCUS_STYLE}
      >
        <Lockup title="Noodara" height={32} />
      </div>
      <h1 className="text-display font-semibold text-ink">Your infrastructure, understood.</h1>
      <p className="max-w-[65ch] text-body font-normal text-ink-secondary">
        Connect a server over SSH, watch Noodara discover it, and see exactly what&apos;s running — no agent, no
        black box.
      </p>
      <InstallCommand />
      <div className="flex flex-wrap items-center gap-4">
        <a href="/docs" className={PRIMARY_CTA_CLASSES}>
          Read the docs
        </a>
        <a href={GITHUB_URL} rel="noopener noreferrer" className={SECONDARY_CTA_CLASSES}>
          View on GitHub
        </a>
      </div>
      <ScreenshotFrame screen="servers" loading="eager" alt="The Noodara servers list with a connected Ubuntu server" />
    </section>
  );
}
