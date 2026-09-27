import { useSyncExternalStore } from 'react';

const REDUCE_QUERY = '(prefers-reduced-motion: reduce)';

// useReducedMotionPreference (D-13, 09-04-PLAN.md Task 2) -- the one place Sheet.tsx's drag
// gesture reads the effective reduced-motion preference. Mirrors exactly the same precedence the
// `motion-safe`/`motion-reduce` Tailwind variants use (packages/ui/theme.css): a forced
// `html[data-motion="reduce"|"allow"]` attribute wins over `prefers-reduced-motion`; an absent
// attribute (or any other value) falls through to the OS media query. Internal to Sheet -- not
// exported from packages/ui/src/index.ts.
function readAttribute(): 'reduce' | 'allow' | null {
  const value = document.documentElement.getAttribute('data-motion');
  return value === 'reduce' || value === 'allow' ? value : null;
}

function readMediaQueryMatches(): boolean {
  try {
    return window.matchMedia(REDUCE_QUERY).matches;
  } catch {
    return false;
  }
}

function getSnapshot(): boolean {
  const attribute = readAttribute();
  if (attribute !== null) {
    return attribute === 'reduce';
  }
  return readMediaQueryMatches();
}

// The server never has `document`/`window` -- a fixed `false` default is environment-independent
// and identical between the server and the very first client render, so there is no hydration
// mismatch to reconcile (mirroring ThemeToggle.tsx's own WR-C-01 fix for the identical class of
// bug).
function getServerSnapshot(): boolean {
  return false;
}

function subscribe(callback: () => void): () => void {
  const observer = new MutationObserver(callback);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });

  let mediaQueryList: MediaQueryList | null = null;
  try {
    mediaQueryList = window.matchMedia(REDUCE_QUERY);
    mediaQueryList.addEventListener('change', callback);
  } catch {
    mediaQueryList = null;
  }

  return () => {
    observer.disconnect();
    mediaQueryList?.removeEventListener('change', callback);
  };
}

export function useReducedMotionPreference(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
