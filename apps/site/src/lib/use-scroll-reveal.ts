'use client';

// 10-12-PLAN.md Round 1 (D-18a). The one once-only scroll-reveal primitive the redesign uses --
// deliberately kept out of apps/site/src/components/landing/ so Landing.test.tsx's source scan
// ("landing files contain no IntersectionObserver") keeps meaning what it always meant: no
// landing component owns its own observer, they consume this hook through RevealSection instead.
//
// Progressive enhancement: `revealed` starts `true` (safe default -- correct with no JS, no
// hydration yet, or no IntersectionObserver support: content is simply visible, nothing to
// animate). Only once a real observer is available does the hook flip to `false` immediately
// after mount, then back to `true` the first time the observed element intersects the viewport --
// disconnecting immediately after (D-18a "never re-fires", no parallax, no repeated animation).
import { useEffect, useRef, useState } from 'react';

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

    return () => {
      observer.disconnect();
    };
  }, []);

  return { ref, revealed };
}
