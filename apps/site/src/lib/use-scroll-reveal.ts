'use client';

// 10-12-PLAN.md Round 1 (D-18a), rewritten in the orchestrator's Round 1 review fix batch. The
// one once-only scroll-reveal primitive the redesign uses -- deliberately kept out of
// apps/site/src/components/landing/ so Landing.test.tsx's source scan ("landing files contain no
// IntersectionObserver") keeps meaning what it always meant: no landing component owns its own
// observer, they consume this hook through RevealSection instead.
//
// Three contracts, in order of priority:
// 1. `revealed` starts `true` (safe default -- correct with no JS, no hydration yet, or no
//    IntersectionObserver support: content is simply visible, nothing to animate).
// 2. A node already inside the initial viewport at mount (`rect.top <= window.innerHeight`) is
//    NEVER hidden -- the previous version unconditionally hid every wrapped section right after
//    mount, which flickered every already-visible section (visible -> hidden -> fade back in) and
//    depended on a 400ms fallback timer to ever show below-fold content again, since Playwright's
//    own full-page screenshot never fires a real scroll/resize event on its own. That fallback
//    timer is gone: `scripts/ui/capture-site-review.ts` now scrolls the real page before
//    capturing, so below-fold sections reveal legitimately through real intersection instead.
// 3. `prefers-reduced-motion: reduce` never hides anything, regardless of position -- checked
//    once at mount (a one-shot reveal decision, not a live-updating preference).
import { useEffect, useRef, useState } from 'react';

export interface ScrollRevealResult<T extends HTMLElement> {
  readonly ref: React.RefObject<T | null>;
  readonly revealed: boolean;
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function useScrollReveal<T extends HTMLElement>(): ScrollRevealResult<T> {
  const ref = useRef<T | null>(null);
  const [revealed, setRevealed] = useState(true);

  useEffect(() => {
    const node = ref.current;
    if (node === null || typeof IntersectionObserver === 'undefined') return;
    if (prefersReducedMotion()) return;

    const rect = node.getBoundingClientRect();
    const alreadyInView = rect.top <= window.innerHeight;
    if (alreadyInView) return;

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

    return () => {
      observer.disconnect();
    };
  }, []);

  return { ref, revealed };
}
