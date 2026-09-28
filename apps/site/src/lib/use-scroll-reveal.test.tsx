// 10-12-PLAN.md Round 1 fix batch (orchestrator review). RED: written before the rewritten
// useScrollReveal exists. Replaces the previous "flip to false immediately after mount, force-
// reveal after a fallback timer" behaviour (which flickered every already-visible section
// visible -> hidden -> visible and never actually revealed on real scroll) with three contracts:
//
// 1. A node already within the initial viewport (`rect.top <= window.innerHeight`) is NEVER
//    hidden -- `revealed` stays `true` for its whole life, no flicker.
// 2. A node below the initial viewport starts hidden, then reveals once it genuinely intersects.
// 3. `prefers-reduced-motion: reduce` never hides anything, regardless of position.
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useScrollReveal } from './use-scroll-reveal';

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
    // no-op: this hook calls disconnect() instead, asserted below.
  }

  disconnect(): void {
    this.disconnected = true;
  }
}

function stubMatchMedia(reduced: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: reduced && query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

/** Stubs `getBoundingClientRect` on every element to report the given `top`, and sets
 *  `window.innerHeight`. jsdom's own layout engine always returns 0 for every rect, so a "below
 *  the fold" node has to be simulated explicitly. */
function stubViewport({ top, innerHeight }: { top: number; innerHeight: number }): void {
  Element.prototype.getBoundingClientRect = vi.fn().mockReturnValue({
    top,
    left: 0,
    right: 0,
    bottom: top,
    width: 0,
    height: 0,
    x: 0,
    y: top,
    toJSON: () => ({}),
  });
  vi.stubGlobal('innerHeight', innerHeight);
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
  vi.restoreAllMocks();
});

describe('useScrollReveal', () => {
  it('defaults revealed=true when IntersectionObserver is unavailable (no-JS-equivalent fallback)', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    let latest = false;
    render(<Probe onState={(revealed) => (latest = revealed)} />);
    expect(latest).toBe(true);
  });

  it('a node already within the initial viewport is never hidden (no flicker)', () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    stubMatchMedia(false);
    stubViewport({ top: 100, innerHeight: 800 });

    let latest = false;
    render(<Probe onState={(revealed) => (latest = revealed)} />);

    expect(latest).toBe(true);
    expect(FakeIntersectionObserver.instances).toHaveLength(0);
  });

  it('a node below the initial viewport hides, then reveals once it genuinely intersects, and disconnects (once)', () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    stubMatchMedia(false);
    stubViewport({ top: 2000, innerHeight: 800 });

    let latest = false;
    render(<Probe onState={(revealed) => (latest = revealed)} />);

    expect(latest).toBe(false);

    const observer = FakeIntersectionObserver.instances.at(-1);
    if (observer === undefined) throw new Error('expected the hook to construct an IntersectionObserver');
    expect(observer.observed).toHaveLength(1);
    const [observedNode] = observer.observed;
    if (observedNode === undefined) throw new Error('expected one observed node');

    act(() => {
      observer.callback([{ isIntersecting: true, target: observedNode }]);
    });

    expect(latest).toBe(true);
    expect(observer.disconnected).toBe(true);
  });

  it('prefers-reduced-motion never hides, even for a node below the initial viewport', () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    stubMatchMedia(true);
    stubViewport({ top: 2000, innerHeight: 800 });

    let latest = false;
    render(<Probe onState={(revealed) => (latest = revealed)} />);

    expect(latest).toBe(true);
    expect(FakeIntersectionObserver.instances).toHaveLength(0);
  });
});
