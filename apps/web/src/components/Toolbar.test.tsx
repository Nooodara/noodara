import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderUi, screen } from '@noodara/ui/testing';
import { ShellContext, type ShellContextValue } from '../lib/shell-context';
import { Toolbar } from './Toolbar';

// 08-10-PLAN.md Task 1/2 (UI-07/UI-10, D-03, 08-UI-SPEC.md SS2.2/SS10): this is the toolbar's
// first component test file. It covers two things a real browser test (tests/e2e/servers-list.spec.ts's
// new `@scroll-edge` case) does not need to re-prove at this level: the untouched prop contract
// (single primaryAction slot, the backLink-vs-menu-button branch, `shell-toolbar` resolving on the
// same root) and the scroll-driven class toggle's two states plus the three accessibility
// fallbacks, all as class-presence assertions -- jsdom has no real layout/scroll engine, so the
// actual rendered pixel (computed `border-bottom-color`) is left to the Playwright spec.
//
// `window.scrollY` is stubbed via `Object.defineProperty` (jsdom's own scrollY is always 0 and
// read-only by default) and a `scroll` event is dispatched on `window` to drive the component's
// own listener -- never `ShellContext`, which stays exactly the shape it already was (T-08-29: the
// scroll state is this component's own concern, never pushed into shared context).

const SHELL_CONTEXT: ShellContextValue = {
  connected: true,
  subscribe: () => () => undefined,
  registerResync: () => () => undefined,
  close: () => undefined,
  closedByCaller: false,
  mobileNavOpen: false,
  toggleMobileNav: () => undefined,
  closeMobileNav: () => undefined,
};

function renderToolbar(props: Partial<Parameters<typeof Toolbar>[0]> = {}) {
  return renderUi(
    <ShellContext.Provider value={SHELL_CONTEXT}>
      <Toolbar title="Servers" {...props} />
    </ShellContext.Provider>,
  );
}

function setScrollY(value: number): void {
  Object.defineProperty(window, 'scrollY', { value, configurable: true, writable: true });
}

function fireWindowScroll(): void {
  window.dispatchEvent(new Event('scroll'));
}

beforeEach(() => {
  setScrollY(0);
});

afterEach(() => {
  setScrollY(0);
  vi.restoreAllMocks();
});

describe('Toolbar prop contract (unchanged by the scroll-edge effect)', () => {
  it('still resolves shell-toolbar on the same root element', () => {
    renderToolbar();
    expect(screen.getByTestId('shell-toolbar')).toBeInTheDocument();
  });

  it('still renders the title as an h1', () => {
    renderToolbar();
    expect(screen.getByRole('heading', { level: 1, name: 'Servers' })).toBeInTheDocument();
  });

  it('still renders a single primaryAction node, never an array', () => {
    renderToolbar({ primaryAction: <button type="button">Add server</button> });
    expect(screen.getAllByRole('button', { name: 'Add server' })).toHaveLength(1);
  });

  it('still renders the mobile menu button when no backLink is given', () => {
    renderToolbar();
    expect(screen.getByTestId('shell-menu-button')).toBeInTheDocument();
  });

  it('still renders the backLink instead of the menu button when one is given', () => {
    renderToolbar({ backLink: { href: '/servers', label: '← Servers' } });
    expect(screen.queryByTestId('shell-menu-button')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '← Servers' })).toHaveAttribute('href', '/servers');
  });
});

describe('Toolbar scroll edge (UI-07/D-03: line only where content actually passes under it)', () => {
  it('carries a transparent border-bottom at scroll position 0', () => {
    renderToolbar();
    expect(screen.getByTestId('shell-toolbar').className).toContain('border-transparent');
  });

  it('swaps to the hairline border-bottom once scrollY exceeds 0', () => {
    renderToolbar();
    setScrollY(40);
    fireWindowScroll();
    expect(screen.getByTestId('shell-toolbar').className).toContain('border-hairline');
  });

  it('swaps back to transparent once the page returns to scroll position 0', () => {
    renderToolbar();
    setScrollY(40);
    fireWindowScroll();
    setScrollY(0);
    fireWindowScroll();
    expect(screen.getByTestId('shell-toolbar').className).toContain('border-transparent');
  });

  it('removes its scroll listener on unmount', () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const { unmount } = renderToolbar();
    unmount();
    expect(removeSpy).toHaveBeenCalledWith('scroll', expect.any(Function));
  });

  it('gates the border-color transition behind motion-safe', () => {
    renderToolbar();
    expect(screen.getByTestId('shell-toolbar').className).toContain('motion-safe:transition-colors');
  });

  it('never uses transition-all/transition: all', () => {
    renderToolbar();
    const className = screen.getByTestId('shell-toolbar').className;
    expect(className).not.toContain('transition-all');
    expect(className).not.toMatch(/transition:\s*all/);
  });
});

describe('Toolbar accessibility alternatives (UI-10)', () => {
  it('drops to a solid bg-surface-1 and disables backdrop-filter under prefers-reduced-transparency', () => {
    renderToolbar();
    const className = screen.getByTestId('shell-toolbar').className;
    expect(className).toContain('[@media(prefers-reduced-transparency:reduce)]:bg-surface-1');
    expect(className).toContain('[@media(prefers-reduced-transparency:reduce)]:[backdrop-filter:none]');
  });

  it('keeps the one permanent backdrop-blur in the default path', () => {
    renderToolbar();
    expect(screen.getByTestId('shell-toolbar').className).toContain('backdrop-blur');
  });

  it('uses border-hairline-strong and a fully opaque background once scrolled, under prefers-contrast: more', () => {
    renderToolbar();
    setScrollY(40);
    fireWindowScroll();
    const className = screen.getByTestId('shell-toolbar').className;
    expect(className).toContain('contrast-more:border-hairline-strong');
    expect(className).toContain('contrast-more:bg-surface-1');
  });
});
