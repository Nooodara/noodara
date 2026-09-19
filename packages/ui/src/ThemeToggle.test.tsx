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
});
