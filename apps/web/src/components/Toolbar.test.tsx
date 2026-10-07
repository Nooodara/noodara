import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, renderUi, screen } from '@noodara/ui/testing';
import { ShellContext, type ShellContextValue } from '../lib/shell-context';
import { Toolbar, TOOLBAR_COMPACT_MAX_WIDTH, toolbarLayout, type ToolbarLayout } from './Toolbar';

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
  fireEvent.scroll(window);
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
    expect(screen.getByTestId('shell-toolbar').className).toContain('motion-safe:transition-[border-color]');
  });

  it('never uses transition-all/transition: all', () => {
    renderToolbar();
    const className = screen.getByTestId('shell-toolbar').className;
    expect(className).not.toContain('transition-all');
    expect(className).not.toMatch(/transition:\s*all/);
  });

  // deferred-items.md 08-11 round 1 (P17 theme flicker): the whole-`transition-colors` form
  // animates every color-family property Tailwind bundles under it, background-color included --
  // on a theme switch that fades the toolbar's own background in over `--duration-panel` while
  // every other surface on the page snaps instantly, a stray grey/near-white band visible in the
  // dark-theme review captures. Only the scroll-edge hairline (border-color) is meant to animate.
  it('never bundles background-color into its own transition (only the scroll-edge border-color animates)', () => {
    renderToolbar();
    const className = screen.getByTestId('shell-toolbar').className;
    expect(className).not.toContain('transition-colors');
    expect(className).not.toMatch(/transition-\[[^\]]*background-color[^\]]*\]/);
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

/** jsdom has no layout: report the toolbar's width as a real browser at `width` px would. */
function atWidth(width: number) {
  return vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ width, height: 52, top: 0, left: 0, right: width, bottom: 52, x: 0, y: 0, toJSON: () => ({}) }),
  );
}

const LONG_TITLE = 'checkoutsettlementreconciliation'.repeat(7).slice(0, 200);

describe('Toolbar layout at narrow widths (14-19 A1)', () => {
  it('goes compact below the threshold, and only once the bar was measured', () => {
    expect(toolbarLayout(375)).toBe('compact');
    expect(toolbarLayout(TOOLBAR_COMPACT_MAX_WIDTH - 1)).toBe('compact');
    expect(toolbarLayout(TOOLBAR_COMPACT_MAX_WIDTH)).toBe('full');
    expect(toolbarLayout(1280)).toBe('full');
    // Not laid out yet (jsdom, first paint): never guess compact.
    expect(toolbarLayout(0)).toBe('full');
  });

  it('at 375 px stays on one row and the title block keeps 12 characters of its own font', () => {
    atWidth(375);
    renderToolbar({ title: LONG_TITLE, primaryAction: <button type="button">Add</button> });

    const toolbar = screen.getByTestId('shell-toolbar');
    expect(toolbar).toHaveAttribute('data-layout', 'compact');
    expect(toolbar.className).toMatch(/\bflex-nowrap\b/);
    expect(toolbar.className).not.toMatch(/\bflex-wrap\b/);
    const titleBlock = screen.getByTestId('shell-toolbar-title');
    expect(titleBlock.className).toMatch(/min-w-\[12ch\]/);
    expect(titleBlock.className).toMatch(/\bflex-1\b/);
    expect(titleBlock.className).toMatch(/\btext-title\b/);
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveAttribute('title', LONG_TITLE);
    expect(heading.className).toMatch(/\btruncate\b/);
    // The actions keep their size and their labels never wrap.
    const actions = screen.getByTestId('shell-toolbar-actions');
    expect(actions.className).toMatch(/\bshrink-0\b/);
    expect(actions.className).toMatch(/\bwhitespace-nowrap\b/);
  });

  it('at 375 px turns the back link into a 44 px arrow named after its destination', () => {
    atWidth(375);
    renderToolbar({ backLink: { href: '/projects', label: '← Projects' } });

    const back = screen.getByRole('link', { name: 'Back to Projects' });
    expect(back).toHaveAttribute('href', '/projects');
    expect(back.className).toMatch(/\bh-11\b/);
    expect(back.className).toMatch(/\bw-11\b/);
    expect(back.className).toMatch(/focus-visible:outline-accent/);
    expect(back).toHaveTextContent('←');
  });

  it('hands the measured layout to slot render functions', () => {
    atWidth(375);
    const seen: ToolbarLayout[] = [];
    renderToolbar({
      secondaryActions: (layout: ToolbarLayout) => {
        seen.push(layout);
        return <span data-testid="secondary">{layout}</span>;
      },
      primaryAction: (layout: ToolbarLayout) => <span data-testid="primary">{layout}</span>,
    });

    expect(screen.getByTestId('secondary')).toHaveTextContent('compact');
    expect(screen.getByTestId('primary')).toHaveTextContent('compact');
    expect(seen).toContain('compact');
  });

  it('at 1280 px keeps the full layout: text back link, slots told "full"', () => {
    atWidth(1280);
    renderToolbar({
      backLink: { href: '/projects', label: '← Projects' },
      secondaryActions: (layout: ToolbarLayout) => <span data-testid="secondary">{layout}</span>,
    });

    expect(screen.getByTestId('shell-toolbar')).toHaveAttribute('data-layout', 'full');
    expect(screen.getByRole('link', { name: '← Projects' })).toBeInTheDocument();
    expect(screen.getByTestId('secondary')).toHaveTextContent('full');
    // A short title is not stretched to 12ch; a long one is floored there.
    expect(screen.getByRole('heading', { level: 1 }).className).not.toMatch(/min-w-\[12ch\]/);
  });

  it('at 1280 px floors a long title at 12ch so the actions cannot squeeze it away', () => {
    atWidth(1280);
    renderToolbar({ title: LONG_TITLE });

    expect(screen.getByRole('heading', { level: 1 }).className).toMatch(/min-w-\[12ch\]/);
  });
});
