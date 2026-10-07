import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderUi, screen, userEvent, within } from '@noodara/ui/testing';
import ProjectsPage from './page';
import { notifyProjectsChanged } from '../../../components/ProjectNav';
import { ShellContext, type ShellContextValue } from '../../../lib/shell-context';

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: nav.push }) }));
const deployApi = vi.hoisted(() => ({ listProjects: vi.fn(), createProject: vi.fn() }));

vi.mock('../../../lib/deploy-api', () => ({
  listProjects: () => deployApi.listProjects() as unknown,
  createProject: (body: unknown) => deployApi.createProject(body) as unknown,
}));
vi.mock('../../../lib/require-session', () => ({ requireSession: () => undefined }));

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

function project(id: string, name: string, extra: Partial<Record<'description' | 'archivedAt' | 'slug', string | null>> = {}) {
  return {
    id,
    name,
    slug: name.toLowerCase(),
    description: null,
    archivedAt: null,
    createdAt: '2026-10-06T00:00:00.000Z',
    updatedAt: '2026-10-06T00:00:00.000Z',
    ...extra,
  };
}

function listing(items: readonly unknown[]) {
  return Promise.resolve({ ok: true, data: { items } });
}

function renderPage() {
  return renderUi(
    <ShellContext.Provider value={SHELL_CONTEXT}>
      <ProjectsPage />
    </ShellContext.Provider>,
  );
}

beforeEach(() => {
  deployApi.listProjects.mockReset();
  deployApi.createProject.mockReset();
  nav.push.mockReset();
});

describe('Projects page (13-09 A2, A3)', () => {
  it('shows skeleton rows while loading', () => {
    deployApi.listProjects.mockReturnValue(new Promise(() => undefined));
    renderPage();
    expect(screen.getByTestId('projects-loading')).toBeInTheDocument();
  });

  it('teaches the hierarchy in one sentence with a single primary action when empty', async () => {
    deployApi.listProjects.mockReturnValue(listing([]));
    renderPage();

    const empty = await screen.findByTestId('projects-empty');
    expect(empty).toHaveTextContent('No projects yet');
    expect(empty).toHaveTextContent('A project holds environments, and each environment runs your services.');
    expect(within(empty).getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByTestId('projects-new-button')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/coming soon|env(ironment)? var/i);
  });

  it('opens the create sheet from the empty state', async () => {
    deployApi.listProjects.mockReturnValue(listing([]));
    renderPage();
    await userEvent.setup().click(within(await screen.findByTestId('projects-empty')).getByRole('button', { name: 'New project' }));
    expect(screen.getByTestId('project-sheet')).toBeInTheDocument();
  });

  it('lists active projects as links, and archived ones apart saying they reject deploys', async () => {
    deployApi.listProjects.mockReturnValue(
      listing([
        project('p2', 'beta', { description: 'Marketing site' }),
        project('p3', 'Legacy', { archivedAt: '2026-01-01T00:00:00.000Z' }),
        project('p1', 'Alpha'),
      ]),
    );
    renderPage();

    const list = await screen.findByTestId('projects-list');
    expect(within(list).getAllByRole('link').map((link) => link.textContent)).toEqual(['Alphaalpha', 'betaMarketing site']);
    expect(within(list).getByRole('link', { name: /Alpha/ })).toHaveAttribute('href', '/projects/p1');

    const archived = screen.getByTestId('projects-archived');
    expect(within(archived).getByRole('link', { name: /Legacy/ })).toHaveAttribute('href', '/projects/p3');
    expect(archived).toHaveTextContent('Archived');
    expect(archived).toHaveTextContent('Archived projects reject new deploys.');
    expect(screen.getByTestId('projects-new-button')).toBeInTheDocument();
  });

  it('shows a retryable banner with the error code when the list fails', async () => {
    deployApi.listProjects.mockReturnValueOnce(Promise.resolve({ ok: false, code: 'NETWORK_ERROR', message: 'x', unauthorized: false }));
    deployApi.listProjects.mockReturnValue(listing([project('p1', 'Alpha')]));
    renderPage();

    const banner = await screen.findByTestId('projects-error-banner');
    expect(banner).toHaveTextContent('NETWORK_ERROR');
    await userEvent.setup().click(within(banner).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('link', { name: /Alpha/ })).toBeInTheDocument();
  });

  it('refetches when a project changes in this tab', async () => {
    deployApi.listProjects.mockReturnValueOnce(listing([]));
    deployApi.listProjects.mockReturnValue(listing([project('p1', 'Alpha')]));
    renderPage();
    await screen.findByTestId('projects-empty');

    act(() => {
      notifyProjectsChanged();
    });
    expect(await screen.findByRole('link', { name: /Alpha/ })).toBeInTheDocument();
  });
});

describe('Projects page hardening (13-09 H1)', () => {
  it('renders hostile and very long names as inert, truncated text with the full name as a tooltip', async () => {
    const hostile = `<img src=x onerror="alert(1)">${'y'.repeat(300)}`;
    deployApi.listProjects.mockReturnValue(listing([project('p1', hostile)]));
    renderPage();

    const link = await screen.findByRole('link', { name: new RegExp(hostile.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });
    expect(link.querySelector('img')).toBeNull();
    expect(within(link).getByTitle(hostile)).toHaveTextContent(hostile);
    expect(within(link).getByTitle(hostile).closest('.truncate')).not.toBeNull();
  });

  it('never links a project whose id could change the route', async () => {
    deployApi.listProjects.mockReturnValue(listing([project('../admin', 'Evil'), project('p1', 'Alpha')]));
    renderPage();
    await screen.findByRole('link', { name: /Alpha/ });
    expect(screen.queryByText('Evil')).not.toBeInTheDocument();
  });
});

describe('Projects page: navigate after create (13-21 A1-A3)', () => {
  async function fillAndSubmit(name: string) {
    deployApi.listProjects.mockReturnValue(listing([]));
    renderPage();
    const user = userEvent.setup();
    await user.click(within(await screen.findByTestId('projects-empty')).getByRole('button', { name: 'New project' }));
    await user.type(await screen.findByTestId('project-sheet-name'), name);
    await user.click(screen.getByTestId('project-sheet-submit'));
  }

  it('navigates to the new project only after the create succeeds', async () => {
    deployApi.createProject.mockResolvedValue({ ok: true, data: project('11111111-1111-4111-8111-111111111111', 'Shop') });
    await fillAndSubmit('Shop');
    await vi.waitFor(() => {
      expect(nav.push).toHaveBeenCalledWith('/projects/11111111-1111-4111-8111-111111111111');
    });
  });

  it('a failed create keeps the sheet open with the input and does not navigate', async () => {
    deployApi.createProject.mockResolvedValue({ ok: false, code: 'NETWORK_ERROR', message: 'x', unauthorized: false });
    await fillAndSubmit('Shop');
    expect(await screen.findByTestId('project-sheet-error')).toBeInTheDocument();
    expect(screen.getByTestId('project-sheet-name')).toHaveValue('Shop');
    expect(nav.push).not.toHaveBeenCalled();
  });
});
