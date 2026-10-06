import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { renderUi, screen, userEvent, waitFor, within } from '@noodara/ui/testing';
import type { ApiResult } from '../lib/api-client';
import { ShellContext, type ShellContextValue } from '../lib/shell-context';
import { Sidebar } from './Sidebar';
import { notifyProjectsChanged } from './ProjectNav';

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

const nav = vi.hoisted(() => ({ pathname: '/servers', replace: vi.fn<(href: string) => void>() }));

vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({
    push: vi.fn(),
    replace: nav.replace,
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

// 13-09: the Projects tree reads deploy-api; each test sets the data it needs.
const deployApi = vi.hoisted(() => ({
  listProjects: vi.fn(),
  listEnvironments: vi.fn(),
  listServices: vi.fn(),
}));

vi.mock('../lib/deploy-api', () => ({
  listProjects: () => deployApi.listProjects() as unknown,
  listEnvironments: (projectId: string) => deployApi.listEnvironments(projectId) as unknown,
  listServices: (projectId: string) => deployApi.listServices(projectId) as unknown,
}));

function sessionUserSuccess(): ApiResult<unknown> {
  return { ok: true, data: { session: { id: 'sess_1' }, user: { name: 'Ada Lovelace', email: 'ada@noodara.test' } } };
}

beforeEach(() => {
  apiGetMock.mockReset();
  apiGetMock.mockResolvedValue(sessionUserSuccess());
  nav.pathname = '/servers';
  nav.replace.mockReset();
  setNavData({ projects: [], environments: [], services: [] });
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
    // 13-09: Projects is the fourth nav link; the marks are still not links.
    expect(within(screen.getByTestId('shell-sidebar')).getAllByRole('link')).toHaveLength(4);
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

  it('still renders the Servers/Activity/Settings nav links', () => {
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

// ---------------------------------------------------------------------------------------------
// 13-09: the Projects hierarchy
// ---------------------------------------------------------------------------------------------

interface FakeProject {
  readonly id: string;
  readonly name: string;
  readonly archivedAt: string | null;
}
interface FakeEnvironment {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
}
interface FakeService {
  readonly id: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly name: string;
  readonly updatedAt: string;
}
interface FakeNavData {
  readonly projects: readonly FakeProject[];
  readonly environments: readonly FakeEnvironment[];
  readonly services: readonly FakeService[];
}

function setNavData(data: FakeNavData): void {
  deployApi.listProjects.mockImplementation(() => Promise.resolve({ ok: true, data: { items: data.projects } }));
  deployApi.listEnvironments.mockImplementation((projectId: string) =>
    Promise.resolve({ ok: true, data: { items: data.environments.filter((e) => e.projectId === projectId) } }),
  );
  deployApi.listServices.mockImplementation((projectId: string) =>
    Promise.resolve({ ok: true, data: { items: data.services.filter((s) => s.projectId === projectId) } }),
  );
}

const T0 = '2026-10-06T00:00:00.000Z';

function service(id: string, name: string, updatedAt = T0, environmentId = 'e1', projectId = 'p1'): FakeService {
  return { id, projectId, environmentId, name, updatedAt };
}

const TREE: FakeNavData = {
  projects: [
    { id: 'p1', name: 'Shop', archivedAt: null },
    { id: 'p2', name: 'Blog', archivedAt: null },
  ],
  environments: [
    { id: 'e1', projectId: 'p1', name: 'production' },
    { id: 'e2', projectId: 'p2', name: 'production' },
  ],
  services: [service('s1', 'api'), service('s2', 'web'), service('s3', 'ghost', T0, 'e2', 'p2')],
};

type DeployListener = (event: unknown) => void;

function renderLiveSidebar() {
  const listeners = new Set<DeployListener>();
  const context = {
    ...SHELL_CONTEXT,
    subscribeDeploy: (listener: DeployListener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeDeploymentLog: () => () => undefined,
  } as ShellContextValue;
  const view = renderUi(
    <ShellContext.Provider value={context}>
      <Sidebar open={false} onClose={() => undefined} />
    </ShellContext.Provider>,
  );
  const emit = (event: unknown): void => {
    act(() => {
      for (const listener of [...listeners]) listener(event);
    });
  };
  return { ...view, emit };
}

describe('Sidebar Projects hierarchy (13-09 A1)', () => {
  it('lists Servers, Projects, Activity and Settings as peers in that order', () => {
    renderSidebar();

    const sidebar = within(screen.getByTestId('shell-sidebar'));
    const order = ['Servers', 'Projects', 'Activity', 'Settings'].map((name) => sidebar.getByRole('link', { name }));
    for (let index = 1; index < order.length; index += 1) {
      expect(precedes(order[index - 1] as Element, order[index] as Element)).toBe(true);
    }
    expect(sidebar.getByRole('link', { name: 'Projects' })).toHaveAttribute('href', '/projects');
  });

  it('opens Projects -> environment -> service on a service page and marks only the service current', async () => {
    setNavData(TREE);
    nav.pathname = '/projects/p1/services/s1';
    renderSidebar();

    const current = await screen.findByRole('link', { name: 'api' });
    expect(current).toHaveAttribute('href', '/projects/p1/services/s1');
    expect(current).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Shop' })).toHaveAttribute('href', '/projects/p1');
    expect(screen.getByRole('link', { name: 'Projects' })).not.toHaveAttribute('aria-current');
    expect(screen.getAllByRole('link').filter((link) => link.getAttribute('aria-current') === 'page')).toHaveLength(1);
  });

  it('expands Projects from the keyboard off the active path', async () => {
    setNavData(TREE);
    renderSidebar();

    const toggle = await screen.findByTestId('nav-tree-toggle-projects');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    toggle.focus();
    await userEvent.setup().keyboard('{Enter}');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: 'Shop' })).toBeInTheDocument();
  });

  it('renders a hostile project name as inert text with the full name as its accessible label (H1)', async () => {
    const hostile = `<img src=x onerror="window.__pwned=1">${'x'.repeat(200)}`;
    setNavData({ projects: [{ id: 'p1', name: hostile, archivedAt: null }], environments: [], services: [] });
    nav.pathname = '/projects/p1';
    renderSidebar();

    const link = await screen.findByRole('link', { name: hostile });
    expect(link).toHaveTextContent(hostile);
    expect(screen.getByTestId('shell-sidebar').querySelector('img')).toBeNull();
    expect(link.querySelector('.truncate')).not.toBeNull();
  });
});

describe('Sidebar live updates (13-09 A4, H2)', () => {
  it('renames and removes services from service.updated / service.deleted without a reload', async () => {
    setNavData(TREE);
    nav.pathname = '/projects/p1';
    const { emit } = renderLiveSidebar();
    await userEvent.setup().click(await screen.findByTestId('nav-tree-toggle-environment-e1'));
    expect(screen.getByRole('link', { name: 'api' })).toBeInTheDocument();

    emit({ type: 'service.updated', service: service('s1', 'api-v2', '2026-10-06T00:00:01.000Z') });
    expect(await screen.findByRole('link', { name: 'api-v2' })).toBeInTheDocument();

    emit({ type: 'service.deleted', id: 's2' });
    await waitFor(() => {
      expect(screen.queryByRole('link', { name: 'web' })).not.toBeInTheDocument();
    });
    expect(nav.replace).not.toHaveBeenCalled();
    expect(deployApi.listProjects).toHaveBeenCalledTimes(1);
  });

  it('moves to the project with a notice when the service being viewed is deleted', async () => {
    setNavData(TREE);
    nav.pathname = '/projects/p1/services/s1';
    const { emit } = renderLiveSidebar();
    await screen.findByRole('link', { name: 'api' });

    emit({ type: 'service.deleted', id: 's1' });

    expect(nav.replace).toHaveBeenCalledWith('/projects/p1');
    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent('This service was deleted');
    await userEvent.setup().click(within(notice).getByRole('button'));
    expect(screen.queryByTestId('sidebar-service-deleted')).not.toBeInTheDocument();
  });

  it('applies a burst of 200 service.updated events and leaves other branches untouched', async () => {
    setNavData(TREE);
    nav.pathname = '/projects/p1/services/s1';
    const { emit } = renderLiveSidebar();
    await screen.findByRole('link', { name: 'api' });
    const sibling = screen.getByRole('link', { name: 'web' });
    const otherProject = screen.getByRole('link', { name: 'Blog' });

    for (let index = 1; index <= 200; index += 1) {
      const stamp = new Date(Date.parse(T0) + index * 1000).toISOString();
      emit({ type: 'service.updated', service: service('s1', `api ${String(index)}`, stamp) });
    }

    expect(await screen.findByRole('link', { name: 'api 200' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'web' })).toBe(sibling);
    expect(screen.getByRole('link', { name: 'Blog' })).toBe(otherProject);
    expect(deployApi.listProjects).toHaveBeenCalledTimes(1);
  });

  it('refetches once when a service arrives for an environment it has not seen', async () => {
    setNavData(TREE);
    nav.pathname = '/projects/p1';
    const { emit } = renderLiveSidebar();
    await screen.findByRole('link', { name: 'Shop' });

    const staging = { id: 'e9', projectId: 'p1', name: 'staging' };
    const added = service('s9', 'worker', T0, 'e9');
    setNavData({ ...TREE, environments: [...TREE.environments, staging], services: [...TREE.services, added] });
    emit({ type: 'service.updated', service: added });

    expect(await screen.findByRole('link', { name: 'staging' })).toHaveAttribute('href', '/projects/p1#environment-e9');
    expect(deployApi.listProjects).toHaveBeenCalledTimes(2);
  });

  it('keeps the tree it shows when a refetch fails', async () => {
    setNavData(TREE);
    nav.pathname = '/projects/p1';
    renderSidebar();
    await screen.findByRole('link', { name: 'Shop' });

    deployApi.listProjects.mockImplementation(() => Promise.resolve({ ok: false, code: 'NETWORK_ERROR' }));
    act(() => {
      notifyProjectsChanged();
    });

    await waitFor(() => {
      expect(deployApi.listProjects).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByRole('link', { name: 'Shop' })).toBeInTheDocument();
  });
});
