import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderUi, screen, waitFor, within } from '@noodara/ui/testing';
import type { ApiResult } from '../lib/api-client';
import { ShellContext, type ShellContextValue } from '../lib/shell-context';
import { Sidebar } from './Sidebar';

// 07-07: the brand mount points in the shell's sidebar (BRAND-02, D-04, D-09). The monogram alone
// belongs to the 64px rail (900-1279px) and the horizontal lockup to the expanded sidebar
// (>=1280px); below 900px the sidebar is a bottom sheet and carries no mark at all. Those three
// states are pure CSS at a single DOM -- both marks are always in the document, one hidden per
// breakpoint (which is exactly why packages/ui's brand components use `data-part` instead of `id`)
// -- so this suite asserts the wrapper's own breakpoint classes rather than visibility, and
// tests/e2e/brand.spec.ts proves the real switch in a real browser at real viewports.
//
// The second job of this file is a regression fence: the mark is ADDED to the sidebar, so every
// test id the 93 E2E specs already depend on (`shell-sidebar`, `shell-sidebar-scrim`,
// `shell-account-menu-trigger`) and the three nav links' own accessible names must still be here
// afterwards (.planning/research/PITFALLS.md, stable test ids).
//
// `next/navigation` is mocked because `usePathname` (Sidebar) and `useRouter` (SignOutButton) both
// require a real Next.js router context that does not exist in jsdom; the shell context is
// supplied for real rather than mocked, since it is a plain React context with a small, fully
// typed value.
//
// 08-08-PLAN.md Task 2: `../lib/api-client`'s `apiGet` is mocked because `Sidebar` now mounts
// `AccountMenu`, which reads the admin's identity through `useSessionUser()` -- a real fetch would
// otherwise throw in jsdom (no server, no `/api/auth/get-session`) on every single test in this
// file, not just the ones that care about identity.

vi.mock('next/navigation', () => ({
  usePathname: () => '/servers',
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

const apiGetMock = vi.fn<(path: string) => Promise<ApiResult<unknown>>>();

vi.mock('../lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api-client')>()),
  apiGet: (path: string) => apiGetMock(path),
}));

function sessionUserSuccess(): ApiResult<unknown> {
  return { ok: true, data: { session: { id: 'sess_1' }, user: { name: 'Ada Lovelace', email: 'ada@noodara.test' } } };
}

beforeEach(() => {
  apiGetMock.mockReset();
  apiGetMock.mockResolvedValue(sessionUserSuccess());
});

afterEach(() => {
  vi.clearAllMocks();
});

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

function renderSidebar(open = false) {
  return renderUi(
    <ShellContext.Provider value={SHELL_CONTEXT}>
      <Sidebar open={open} onClose={() => undefined} />
    </ShellContext.Provider>,
  );
}

/** True when `first` comes before `second` in document order. */
function precedes(first: Element, second: Element): boolean {
  return (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

describe('Sidebar brand slot', () => {
  it('renders the monogram as an svg painted with currentColor, inside the sidebar nav', () => {
    renderSidebar();

    const monogram = screen.getByTestId('brand-monogram');
    expect(monogram.tagName.toLowerCase()).toBe('svg');
    expect(monogram.getAttribute('fill')).toBe('currentColor');
    expect(within(screen.getByTestId('shell-sidebar')).getByTestId('brand-monogram')).toBe(monogram);
  });

  it('renders the lockup as an svg painted with currentColor, inside the sidebar nav', () => {
    renderSidebar();

    const lockup = screen.getByTestId('brand-lockup');
    expect(lockup.tagName.toLowerCase()).toBe('svg');
    expect(lockup.getAttribute('fill')).toBe('currentColor');
    expect(within(screen.getByTestId('shell-sidebar')).getByTestId('brand-lockup')).toBe(lockup);
  });

  it('wraps the monogram in a rail-only wrapper: hidden by default, flex from 900px, hidden again from 1280px', () => {
    renderSidebar();

    const wrapper = screen.getByTestId('brand-monogram').parentElement;
    expect(wrapper).not.toBeNull();
    expect(wrapper?.className).toContain('hidden');
    expect(wrapper?.className).toContain('min-[900px]:flex');
    expect(wrapper?.className).toContain('min-[1280px]:hidden');
  });

  it('wraps the lockup in an expanded-only wrapper: hidden by default, flex from 1280px', () => {
    renderSidebar();

    const wrapper = screen.getByTestId('brand-lockup').parentElement;
    expect(wrapper).not.toBeNull();
    expect(wrapper?.className).toContain('hidden');
    expect(wrapper?.className).toContain('min-[1280px]:flex');
    expect(wrapper?.className).not.toContain('min-[900px]:flex');
  });

  it('places both marks before the nav list in document order', () => {
    const { container } = renderSidebar();

    const list = container.querySelector('[data-testid="shell-sidebar"] > ul');
    expect(list).not.toBeNull();
    const monogram = screen.getByTestId('brand-monogram');
    const lockup = screen.getByTestId('brand-lockup');
    expect(list === null ? false : precedes(monogram, list)).toBe(true);
    expect(list === null ? false : precedes(lockup, list)).toBe(true);
  });

  it('names both marks "Noodara" as images, since the rail shows no brand text at all', () => {
    renderSidebar();

    expect(screen.getAllByRole('img', { name: 'Noodara' })).toHaveLength(2);
    expect(screen.getByTestId('brand-monogram')).toHaveAttribute('role', 'img');
    expect(screen.getByTestId('brand-lockup')).toHaveAttribute('role', 'img');
  });

  it('never paints the mark in a colour of its own -- no fill/stroke other than currentColor', () => {
    renderSidebar();

    for (const testId of ['brand-monogram', 'brand-lockup']) {
      const svg = screen.getByTestId(testId);
      expect(svg.getAttribute('fill')).toBe('currentColor');
      expect(svg.getAttribute('stroke')).toBeNull();
      for (const path of svg.querySelectorAll('path')) {
        expect(path.getAttribute('fill')).toBeNull();
      }
    }
  });

  it('does not make the mark a link or a control (Phase 8 decides that, not this plan)', () => {
    renderSidebar();

    const monogramWrapper = screen.getByTestId('brand-monogram').parentElement;
    expect(monogramWrapper?.tagName.toLowerCase()).toBe('div');
    const lockupWrapper = screen.getByTestId('brand-lockup').parentElement;
    expect(lockupWrapper?.tagName.toLowerCase()).toBe('div');
    expect(within(screen.getByTestId('shell-sidebar')).getAllByRole('link')).toHaveLength(3);
  });
});

describe('Sidebar existing contract (unchanged by the brand slot)', () => {
  it('still renders the sidebar nav and the account menu trigger test id', () => {
    renderSidebar();

    expect(screen.getByTestId('shell-sidebar')).toBeInTheDocument();
    expect(screen.getByTestId('shell-account-menu-trigger')).toBeInTheDocument();
  });

  it('still renders the scrim only when open', () => {
    const { unmount } = renderSidebar(false);
    expect(screen.queryByTestId('shell-sidebar-scrim')).not.toBeInTheDocument();
    unmount();

    renderSidebar(true);
    expect(screen.getByTestId('shell-sidebar-scrim')).toBeInTheDocument();
  });

  it('still renders the three nav links with their Servers/Activity/Settings labels', () => {
    renderSidebar();

    const nav = within(screen.getByTestId('shell-sidebar'));
    expect(nav.getByRole('link', { name: 'Servers' })).toHaveAttribute('href', '/servers');
    expect(nav.getByRole('link', { name: 'Activity' })).toHaveAttribute('href', '/activity');
    expect(nav.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings');
  });

  it('still marks the current route with aria-current', () => {
    renderSidebar();

    const nav = within(screen.getByTestId('shell-sidebar'));
    expect(nav.getByRole('link', { name: 'Servers' })).toHaveAttribute('aria-current', 'page');
    expect(nav.getByRole('link', { name: 'Activity' })).not.toHaveAttribute('aria-current');
  });

  it('still renders each nav link through NavTree with its own nav-tree-item-{id} testid', () => {
    renderSidebar();

    expect(screen.getByTestId('nav-tree-item-servers')).toHaveAttribute('href', '/servers');
    expect(screen.getByTestId('nav-tree-item-activity')).toHaveAttribute('href', '/activity');
    expect(screen.getByTestId('nav-tree-item-settings')).toHaveAttribute('href', '/settings');
  });
});

// 08-07 (D-03): the sidebar's chrome retreats -- it fuses with the page's own canvas at >=900px
// and loses its own right-edge border entirely; the below-900px bottom sheet is a temporary
// overlay and keeps its own surface + top border so it still reads as a sheet over the content.
describe('Sidebar chrome (D-03: fuses with canvas at >=900px)', () => {
  it('carries bg-canvas and no border-r on the nav element, while still keeping the mobile sheet surface/border-t', () => {
    renderSidebar();

    const nav = screen.getByTestId('shell-sidebar');
    expect(nav.className).toContain('bg-canvas');
    expect(nav.className).not.toContain('border-r');
    expect(nav.className).toContain('bg-surface-1');
    expect(nav.className).toContain('border-t');
  });
});

// 08-08-PLAN.md Task 2 (UI-11, D-05, T-08-25): the old ThemeToggle+SignOutButton cluster is gone --
// AccountMenu is the shell's one identity affordance, fed by useSessionUser()'s one-shot fetch.
describe('Sidebar account menu (D-05: single trigger, fed by useSessionUser)', () => {
  it('shows the admin name inside the trigger once the session fetch resolves', async () => {
    renderSidebar();

    await waitFor(() => {
      expect(screen.getByTestId('shell-account-menu-trigger')).toHaveTextContent('Ada Lovelace');
    });
  });

  it('degrades to a nameless trigger, never a broken sidebar, when the session fetch rejects', async () => {
    apiGetMock.mockReset();
    apiGetMock.mockRejectedValue(new Error('network down'));

    renderSidebar();

    // The sidebar and its account trigger render immediately regardless of the outcome -- a
    // rejected fetch must never blank the sidebar or throw during render.
    expect(screen.getByTestId('shell-sidebar')).toBeInTheDocument();
    const trigger = screen.getByTestId('shell-account-menu-trigger');
    expect(trigger).toBeInTheDocument();

    await waitFor(() => {
      expect(apiGetMock).toHaveBeenCalledWith('/api/auth/get-session');
    });
    expect(trigger).not.toHaveTextContent('Ada Lovelace');
  });

  it('degrades to a nameless trigger when the session fetch answers a non-ok result', async () => {
    apiGetMock.mockReset();
    apiGetMock.mockResolvedValue({ ok: false, code: 'UNAUTHORIZED', message: 'nope', unauthorized: true });

    renderSidebar();

    expect(screen.getByTestId('shell-account-menu-trigger')).toBeInTheDocument();
    await waitFor(() => {
      expect(apiGetMock).toHaveBeenCalledWith('/api/auth/get-session');
    });
    expect(screen.getByTestId('shell-account-menu-trigger')).not.toHaveTextContent('Ada Lovelace');
  });

  // 08-19-PLAN.md Task 3 (G3 adjustment round 1, item 5, D-05 change): ThemeToggle moved out of
  // the account menu into an Appearance InsetGroup on /settings
  // (apps/web/src/components/SettingsGroups.test.tsx's own new coverage) -- the sidebar mounts no
  // ThemeToggle at all anymore, direct or through AccountMenu.
  it('mounts no ThemeToggle at all -- it now lives in the Appearance group on /settings, not the account menu', async () => {
    const user = await import('@testing-library/user-event').then((m) => m.userEvent.setup());
    renderSidebar();

    await user.click(screen.getByTestId('shell-account-menu-trigger'));

    expect(screen.queryByTestId('shell-account-menu-theme-toggle')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Theme:/)).not.toBeInTheDocument();
  });

  it('mounts the sign-out control inside the menu under its new testid', async () => {
    const user = await import('@testing-library/user-event').then((m) => m.userEvent.setup());
    renderSidebar();

    await user.click(screen.getByTestId('shell-account-menu-trigger'));

    expect(screen.getByTestId('shell-account-menu-sign-out')).toBeInTheDocument();
  });
});
