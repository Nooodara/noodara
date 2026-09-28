'use client';

// 10-12-PLAN.md Round 1 (D-18a). The only place a landing section opts into the once-only scroll
// reveal -- consumes useScrollReveal (apps/site/src/lib/, not this directory) so this file, like
// every other file under components/landing/, never names the browser observer API it wraps
// (Landing.test.tsx's own source scan bans that literal string here on purpose -- see
// use-scroll-reveal.ts for the observer itself). Default-visible (data-revealed defaults true in
// the hook), so content never depends on JS to be readable.
import type { ReactNode } from 'react';
import { useScrollReveal } from '../../lib/use-scroll-reveal';

const REVEAL_CLASSES =
  'opacity-100 translate-y-0 transition-[opacity,transform] duration-[var(--duration-panel)] ease-[var(--ease-out)] ' +
  'motion-reduce:transition-none motion-reduce:translate-y-0 data-[revealed=false]:opacity-0 data-[revealed=false]:translate-y-2';

export function RevealSection({ children }: { children: ReactNode }) {
  const { ref, revealed } = useScrollReveal<HTMLDivElement>();
  return (
    <div ref={ref} data-revealed={revealed} className={REVEAL_CLASSES}>
      {children}
    </div>
  );
}
