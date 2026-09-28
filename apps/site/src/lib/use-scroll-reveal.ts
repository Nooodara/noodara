'use client';

// 10-12-PLAN.md Round 1 (D-18a). The one once-only scroll-reveal primitive the redesign uses --
// deliberately kept out of apps/site/src/components/landing/ so Landing.test.tsx's source scan
// ("landing files contain no IntersectionObserver") keeps meaning what it always meant: no
// landing component owns its own observer, they consume this hook through RevealSection instead.
//
// Progressive enhancement, belt-and-suspenders: `revealed` starts `true` (correct with no JS, no
// hydration yet, or no IntersectionObserver support -- content is simply visible, nothing to
// animate). Once a real observer is available it flips to `false` immediately after mount, then
// back to `true` the first time the observed element intersects the viewport, disconnecting
// immediately after (D-18a "never re-fires"). A REVEAL_FALLBACK_MS safety timer also force-reveals
// regardless of intersection: Playwright's own full-page screenshot (scripts/ui/
// capture-site-review.ts) renders content beyond the configured viewport without ever firing a
// real scroll or resize event, so an element below the fold would otherwise never intersect and
// stay hidden forever in that capture. The same guarantee protects any real visitor whose
// environment never delivers a genuine intersection change -- content must never depend on a
// scroll happening to become readable.
import { useEffect, useRef, useState } from 'react';

const REVEAL_FALLBACK_MS = 400;

export interface ScrollRevealResult<T extends HTMLElement> {
  readonly ref: React.RefObject<T | null>;
  readonly revealed: boolean;
}

export function useScrollReveal<T extends HTMLElement>(): ScrollRevealResult<T> {
  const ref = useRef<T | null>(null);
  const [revealed, setRevealed] = useState(true);

  useEffect(() => {
    const node = ref.current;
    if (node === null || typeof IntersectionObserver === 'undefined') return;

    setRevealed(false);

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setRevealed(true);
            observer.disconnect();
          }
        }
      },
      { threshold: 0.15 },
    );
    observer.observe(node);

    const fallback = setTimeout(() => {
      setRevealed(true);
      observer.disconnect();
    }, REVEAL_FALLBACK_MS);

    return () => {
      observer.disconnect();
      clearTimeout(fallback);
    };
  }, []);

  return { ref, revealed };
}
