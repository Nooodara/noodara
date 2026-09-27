import { renderHook, waitFor } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReducedMotionPreference } from './use-reduced-motion-preference.js';

// D-13 (09-04-PLAN.md Task 2): the Sheet's JS gesture check needs the exact same effective
// preference as the CSS `motion-safe:`/`motion-reduce:` variants (packages/ui/theme.css) --
// `html[data-motion]` wins over `prefers-reduced-motion` when present, and the media query is the
// fallback when it is absent.
type Listener = () => void;

function stubMatchMedia(matches: boolean): { dispatch: () => void } {
  let listener: Listener | null = null;
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: (event: string, cb: Listener) => {
        if (event === 'change') listener = cb;
      },
      removeEventListener: (event: string, cb: Listener) => {
        if (event === 'change' && listener === cb) listener = null;
      },
      dispatchEvent: vi.fn(),
    })),
  );
  return {
    dispatch: () => {
      listener?.();
    },
  };
}

beforeEach(() => {
  document.documentElement.removeAttribute('data-motion');
});

afterEach(() => {
  document.documentElement.removeAttribute('data-motion');
  vi.unstubAllGlobals();
});

describe('useReducedMotionPreference', () => {
  it('returns true when html has data-motion="reduce", regardless of matchMedia', () => {
    stubMatchMedia(false);
    document.documentElement.setAttribute('data-motion', 'reduce');

    const { result } = renderHook(() => useReducedMotionPreference());

    expect(result.current).toBe(true);
  });

  it('returns false when html has data-motion="allow", regardless of matchMedia', () => {
    stubMatchMedia(true);
    document.documentElement.setAttribute('data-motion', 'allow');

    const { result } = renderHook(() => useReducedMotionPreference());

    expect(result.current).toBe(false);
  });

  it('with no attribute, returns matchMedia(\'(prefers-reduced-motion: reduce)\').matches', () => {
    stubMatchMedia(true);

    const { result } = renderHook(() => useReducedMotionPreference());

    expect(result.current).toBe(true);
  });

  it('with no attribute and matchMedia false, returns false', () => {
    stubMatchMedia(false);

    const { result } = renderHook(() => useReducedMotionPreference());

    expect(result.current).toBe(false);
  });

  it('re-renders with the new value when the data-motion attribute changes (MutationObserver)', async () => {
    stubMatchMedia(false);
    const { result } = renderHook(() => useReducedMotionPreference());

    expect(result.current).toBe(false);

    document.documentElement.setAttribute('data-motion', 'reduce');

    await waitFor(() => {
      expect(result.current).toBe(true);
    });
  });

  it('re-renders with the new value when the media query changes', async () => {
    const { dispatch } = stubMatchMedia(false);
    const { result } = renderHook(() => useReducedMotionPreference());

    expect(result.current).toBe(false);

    stubMatchMedia(true);
    dispatch();

    await waitFor(() => {
      expect(result.current).toBe(true);
    });
  });

  it('returns false when matchMedia access throws', () => {
    vi.stubGlobal('matchMedia', () => {
      throw new Error('matchMedia unavailable');
    });

    const { result } = renderHook(() => useReducedMotionPreference());

    expect(result.current).toBe(false);
  });

  it('produces a false server snapshot -- no hydration mismatch even with a stored reduce preference', () => {
    document.documentElement.setAttribute('data-motion', 'reduce');

    function Harness() {
      const reduced = useReducedMotionPreference();
      return <span>{reduced ? 'reduced' : 'full'}</span>;
    }

    const serverHtml = renderToString(<Harness />);
    expect(serverHtml).toContain('full');
  });
});
