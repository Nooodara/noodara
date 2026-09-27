// 09-07-PLAN.md Task 2 (D-09, D-11): unit coverage for THEME_BOOTSTRAP_SCRIPT's new division of
// labour -- the SSR root layout now sets data-theme for an explicit light/dark preference before
// this script ever runs, so the script's own job shrinks to exactly two cases: an explicit/auto
// SSR cookie (data-theme already present, or "auto" signalled via the cookie's mere presence) and
// no cookie at all (fall back to the legacy noodara-theme localStorage cache, then matchMedia).
// `.tsx` extension (not `.ts`) is deliberate -- Vitest's `dom` project (vitest.config.ts) only
// picks up `apps/web/src/**/*.test.tsx`, and this suite needs jsdom's `document`/`localStorage`/
// `matchMedia` globals, not the node environment `apps/web/src/**/*.test.ts` runs under.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { THEME_BOOTSTRAP_SCRIPT } from './theme-script';

// The script is a self-invoking function expression string with zero interpolation (T-5-29,
// T-09-24) -- `new Function` evaluates it against the real jsdom globals exactly like a real
// `<script>` tag would, without ever going through `dangerouslySetInnerHTML`/React at all.
function runBootstrapScript(): void {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- the whole point of this test is
  // evaluating the exact script string layout.tsx injects, not a callback of our own.
  new Function(THEME_BOOTSTRAP_SCRIPT)();
}

function stubMatchMedia(prefersDark: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: prefersDark,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

function clearPreferencesCookie(): void {
  document.cookie = 'noodara-prefs=; Path=/; Max-Age=0';
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  clearPreferencesCookie();
  stubMatchMedia(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearPreferencesCookie();
});

describe('THEME_BOOTSTRAP_SCRIPT', () => {
  it('is a zero-interpolation string constant', () => {
    expect(THEME_BOOTSTRAP_SCRIPT).not.toContain('${');
  });

  it('does not change data-theme when the SSR root layout already set it', () => {
    document.documentElement.setAttribute('data-theme', 'light');
    stubMatchMedia(true);

    runBootstrapScript();

    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
  });

  it('falls back to the legacy noodara-theme localStorage value when there is no data-theme and no noodara-prefs cookie', () => {
    localStorage.setItem('noodara-theme', 'dark');

    runBootstrapScript();

    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
  });

  it('uses matchMedia and ignores a stale localStorage value when the noodara-prefs cookie is present (SSR resolved auto)', () => {
    document.cookie = 'noodara-prefs=auto.system.comfortable; Path=/';
    localStorage.setItem('noodara-theme', 'light');
    stubMatchMedia(true);

    runBootstrapScript();

    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
  });

  it('falls back to matchMedia when there is no data-theme, no cookie and no localStorage value', () => {
    stubMatchMedia(true);

    runBootstrapScript();

    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
  });

  it('never throws when localStorage access throws (privacy mode)', () => {
    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });

    try {
      expect(() => {
        runBootstrapScript();
      }).not.toThrow();
    } finally {
      getItemSpy.mockRestore();
    }
  });
});
