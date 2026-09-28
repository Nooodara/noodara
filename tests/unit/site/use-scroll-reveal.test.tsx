// 10-12-PLAN.md Round 1 (D-18a). RED: written before apps/site/src/lib/use-scroll-reveal.ts
// exists. This is the ONE file in apps/site allowed to reference IntersectionObserver literally
// (Landing.test.tsx's source scan bans it inside components/landing/ -- the hook lives outside
// that directory on purpose, consumed only through the RevealSection wrapper component).
//
// Progressive-enhancement contract: `revealed` starts `true` (safe default -- content is visible
// before hydration and with no JS/no IntersectionObserver support), then briefly flips to `false`
// only when a real observer is available, until the element's first intersection fires it back to
// `true` and the observer disconnects (once-only, D-18a: "never re-fires").

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useScrollReveal } from '../../../apps/site/src/lib/use-scroll-reveal';

type ObserverCallback = (entries: readonly { isIntersecting: boolean; target: Element }[]) => void;

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  callback: ObserverCallback;
  observed: Element[] = [];
  disconnected = false;

  constructor(callback: ObserverCallback) {
    this.callback = callback;
    FakeIntersectionObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.observed.push(target);
  }

  unobserve(): void {
    // no-op: this hook is expected to call disconnect() instead, asserted below.
  }

  disconnect(): void {
    this.disconnected = true;
  }
}

function Probe({ onState }: { onState: (revealed: boolean) => void }) {
  const { ref, revealed } = useScrollReveal<HTMLDivElement>();
  onState(revealed);
  return <div ref={ref} data-testid="probe" />;
}

afterEach(() => {
  cleanup();
  FakeIntersectionObserver.instances = [];
  vi.unstubAllGlobals();
});

describe('useScrollReveal', () => {
  it('defaults revealed=true when IntersectionObserver is unavailable (no-JS-equivalent fallback)', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    let latest = false;
    render(<Probe onState={(revealed) => (latest = revealed)} />);
    expect(latest).toBe(true);
  });

  it('flips to false after mount, then back to true once the observed element intersects, and disconnects (once)', () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    let latest = false;
    render(<Probe onState={(revealed) => (latest = revealed)} />);

    // After mount, the effect observed the real DOM node and (because it is not yet reported
    // intersecting) flipped revealed to false.
    expect(latest).toBe(false);

    const observer = FakeIntersectionObserver.instances.at(-1);
    expect(observer).toBeDefined();
    expect(observer?.observed).toHaveLength(1);

    act(() => {
      observer?.callback([{ isIntersecting: true, target: observer.observed[0] as Element }]);
    });

    expect(latest).toBe(true);
    expect(observer?.disconnected).toBe(true);
  });
});
