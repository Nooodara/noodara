import { act } from 'react';
import { renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEY, ThemeToggle } from './ThemeToggle.js';
import { renderUi, screen, userEvent } from './testing/render.js';

// jsdom implements localStorage but not matchMedia -- every test stubs it via vi.stubGlobal
// (this plan's own read_first note). localStorage and document.documentElement's data-theme
// attribute are reset in beforeEach so tests never depend on execution order.
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

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  stubMatchMedia(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ThemeToggle', () => {
  it('cycles light -> dark -> system across three successive clicks, writing/removing localStorage accordingly', async () => {
    const user = userEvent.setup();
    renderUi(<ThemeToggle />);
    const button = screen.getByRole('button');

    await user.click(button);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('light');

    await user.click(button);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('dark');

    await user.click(button);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('tracks the cycle on document.documentElement\'s data-theme attribute, resolving system via matchMedia', async () => {
    const user = userEvent.setup();
    stubMatchMedia(true);
    renderUi(<ThemeToggle />);
    const button = screen.getByRole('button');

    await user.click(button);
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');

    await user.click(button);
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');

    await user.click(button);
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark'); // matchMedia stubbed to prefer dark
  });

  it('has an accessible name that states the current mode, not an unlabelled icon', async () => {
    const user = userEvent.setup();
    renderUi(<ThemeToggle />);

    expect(screen.getByRole('button', { name: /system/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button'));

    expect(screen.getByRole('button', { name: /light/i })).toBeInTheDocument();
  });

  it('does not throw and still updates data-theme when localStorage.setItem throws (storage disabled or full)', async () => {
    const user = userEvent.setup();
    renderUi(<ThemeToggle />);
    const button = screen.getByRole('button');
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    try {
      await expect(user.click(button)).resolves.not.toThrow();
      expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    } finally {
      setItemSpy.mockRestore();
    }
  });

  it('renders without crashing and defaults to system when localStorage.getItem throws on mount', () => {
    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });

    try {
      expect(() => renderUi(<ThemeToggle />)).not.toThrow();
      expect(screen.getByRole('button', { name: /system/i })).toBeInTheDocument();
    } finally {
      getItemSpy.mockRestore();
    }
  });

  it('only ever writes "light" or "dark" to data-theme across the whole cycle, never a raw "system" string', async () => {
    const user = userEvent.setup();
    renderUi(<ThemeToggle />);
    const button = screen.getByRole('button');

    await user.click(button);
    expect(['light', 'dark']).toContain(document.documentElement.getAttribute('data-theme'));

    await user.click(button);
    expect(['light', 'dark']).toContain(document.documentElement.getAttribute('data-theme'));

    await user.click(button);
    expect(['light', 'dark']).toContain(document.documentElement.getAttribute('data-theme'));
  });

  // WR-C-01 (05-VERIFICATION.md gap 8 / 05-35-PLAN.md Task 2): a user with a stored 'dark'
  // preference previously got a real React hydration mismatch, because the component's initial
  // `useState` initialiser read `localStorage` directly -- something the server can never do,
  // but jsdom's `Storage.prototype` always can. This test forces a genuine server/client split by
  // making `getItem` throw only during the `renderToString` pass (simulating "no window" the way
  // a real Next.js server render has no `localStorage` at all), exactly as `readStoredTheme`'s own
  // try/catch already treats a throwing storage -- then hydrates a real stored 'dark' value
  // against that server markup and asserts React logs no hydration-mismatch warning. This is the
  // harness's only way to exercise the actual server/first-client-render divergence: jsdom has no
  // concept of "no window" on its own, so `renderToString` and `hydrateRoot` would otherwise both
  // read the exact same `localStorage`, and the bug (and the fix) would be invisible to the test.
  it('produces identical server and first-client markup for a user with a stored dark preference (no hydration mismatch)', () => {
    localStorage.setItem(STORAGE_KEY, 'dark');

    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('localStorage is not defined (simulated server render)');
    });
    let serverHtml: string;
    try {
      serverHtml = renderToString(<ThemeToggle />);
    } finally {
      getItemSpy.mockRestore();
    }
    // The server never sees the stored preference -- its markup must be the deterministic default.
    expect(serverHtml).toContain('Theme: System');

    const container = document.createElement('div');
    container.innerHTML = serverHtml;
    document.body.appendChild(container);

    // `onRecoverableError` is React's own documented, synchronous hook for exactly this case: it
    // fires once per hydration mismatch React had to silently regenerate client-side -- the
    // deterministic signal this test needs, unlike `console.error` (React 19 throws internally and
    // recovers before ever calling it in this code path) or an uncaught exception (thrown from
    // inside React's own scheduler, outside this synchronous `act()` call).
    const recoverableErrors: unknown[] = [];
    let root: ReturnType<typeof hydrateRoot> | undefined;
    try {
      act(() => {
        root = hydrateRoot(container, <ThemeToggle />, {
          onRecoverableError: (error) => {
            recoverableErrors.push(error);
          },
        });
      });

      expect(recoverableErrors).toEqual([]);

      // After the mount effect settles, the toggle adopts the real stored preference -- the fix
      // only defers the read, it never abandons it.
      expect(container.querySelector('button')).toHaveAttribute('aria-label', 'Theme: Dark');
    } finally {
      act(() => {
        root?.unmount();
      });
      document.body.removeChild(container);
    }
  });
});
