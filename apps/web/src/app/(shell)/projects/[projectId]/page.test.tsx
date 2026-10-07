import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderUi, screen, userEvent, waitFor, within } from '@noodara/ui/testing';
import { ENVIRONMENT_NOT_EMPTY_COPY } from '../../../../components/EnvironmentSheet';
import ProjectPage from './page';
import { subscribeProjectsChanged } from '../../../../components/ProjectNav';
import { ENVIRONMENT_NAME_TAKEN_COPY } from '../../../../components/EnvironmentSheet';
import { ShellContext, type ShellContextValue } from '../../../../lib/shell-context';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const PROD_ID = '22222222-2222-4222-8222-222222222222';
const STAGING_ID = '33333333-3333-4333-8333-333333333333';
const SERVICE_ID = '44444444-4444-4444-8444-444444444444';
const SERVER_ID = '55555555-5555-4555-8555-555555555555';
const NEW_SERVICE_ID = '66666666-6666-4666-8666-666666666666';

const nav = vi.hoisted(() => ({ params: { projectId: '' }, push: vi.fn() }));
const deployApi = vi.hoisted(() => ({
  getProject: vi.fn(),
  listEnvironments: vi.fn(),
  listServices: vi.fn(),
  createEnvironment: vi.fn(),
  deleteEnvironment: vi.fn(),
  updateProject: vi.fn(),
  archiveProject: vi.fn(),
  unarchiveProject: vi.fn(),
  deleteProject: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useParams: () => nav.params,
  useRouter: () => ({ push: nav.push, replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('../../../../lib/deploy-api', () => ({
  getProject: (id: string) => deployApi.getProject(id) as unknown,
  listEnvironments: (id: string) => deployApi.listEnvironments(id) as unknown,
  listServices: (id: string) => deployApi.listServices(id) as unknown,
  createEnvironment: (id: string, body: unknown) => deployApi.createEnvironment(id, body) as unknown,
  deleteEnvironment: (id: string, environmentId: string, confirmName: string) =>
    deployApi.deleteEnvironment(id, environmentId, confirmName) as unknown,
  updateProject: (id: string, body: unknown) => deployApi.updateProject(id, body) as unknown,
  archiveProject: (id: string) => deployApi.archiveProject(id) as unknown,
  unarchiveProject: (id: string) => deployApi.unarchiveProject(id) as unknown,
  deleteProject: (id: string, confirmName: string) => deployApi.deleteProject(id, confirmName) as unknown,
}));
vi.mock('../../../../lib/require-session', () => ({ requireSession: () => undefined }));
const apiClient = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('../../../../lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  apiGet: (path: string) => apiClient.apiGet(path) as unknown,
}));
// ServiceSheet itself is covered by ServiceSheet.test.tsx; here only how the page opens it and reacts to a save.
vi.mock('../../../../components/ServiceSheet', () => ({
  ServiceSheet: (props: {
    open: boolean;
    environmentId: string;
    servers: readonly { id: string }[];
    service?: unknown;
    onSaved?: (service: unknown, info: { requiresRedeploy: boolean }) => void;
    onOpenChange: (open: boolean) => void;
  }) =>
    props.open ? (
      <div data-testid="service-sheet" data-mode={props.service === undefined ? 'create' : 'edit'} data-environment={props.environmentId}>
        <span data-testid="service-sheet-servers">{props.servers.map((server) => server.id).join(',')}</span>
        <button
          type="button"
          onClick={() => {
            props.onSaved?.({}, { requiresRedeploy: false });
            props.onOpenChange(false);
          }}
        >
          Save stub
        </button>
      </div>
    ) : null,
}));

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

const STAMP = '2026-10-06T00:00:00.000Z';

function project(archivedAt: string | null = null) {
  return { id: PROJECT_ID, name: 'Billing', slug: 'billing', description: null, archivedAt, createdAt: STAMP, updatedAt: STAMP };
}

function environment(id: string, name: string) {
  return { id, projectId: PROJECT_ID, name, kind: name, createdAt: STAMP, updatedAt: STAMP };
}

function service(id: string, environmentId: string, name: string) {
  return {
    id,
    projectId: PROJECT_ID,
    environmentId,
    serverId: '55555555-5555-4555-8555-555555555555',
    name,
    sourceType: 'image' as 'git' | 'image',
    repositoryUrl: null as string | null,
    branch: null as string | null,
    buildContext: null,
    dockerfilePath: null,
    buildTarget: null,
    imageRef: 'nginx:1.27' as string | null,
    internalPort: 80,
    publishedPort: 8080,
    status: 'running',
    createdAt: STAMP,
    updatedAt: STAMP,
  };
}

const ok = <T,>(data: T) => Promise.resolve({ ok: true, data });
const failure = (code: string) => Promise.resolve({ ok: false, code, message: 'raw server text', unauthorized: false });

function seed({ environments = [environment(PROD_ID, 'production'), environment(STAGING_ID, 'staging')], services = [service(SERVICE_ID, PROD_ID, 'api')] } = {}) {
  deployApi.getProject.mockImplementation(() => ok(project()));
  deployApi.listEnvironments.mockImplementation(() => ok({ items: environments }));
  deployApi.listServices.mockImplementation(() => ok({ items: services }));
}

function renderPage() {
  const user = userEvent.setup();
  renderUi(
    <ShellContext.Provider value={SHELL_CONTEXT}>
      <ProjectPage />
    </ShellContext.Provider>,
  );
  return user;
}

async function openEnvironmentDelete(user: ReturnType<typeof userEvent.setup>, environmentId: string) {
  await user.click(await screen.findByTestId(`environment-menu-${environmentId}`));
  await user.click(await screen.findByRole('menuitem', { name: 'Delete environment' }));
  return screen.findByTestId('environment-delete-dialog');
}

beforeEach(() => {
  nav.params = { projectId: PROJECT_ID };
  nav.push.mockReset();
  for (const fn of Object.values(deployApi)) fn.mockReset();
  apiClient.apiGet.mockReset();
  apiClient.apiGet.mockImplementation(() => ok({ items: [{ id: SERVER_ID, name: 'edge-1' }] }));
});

describe('Project page (13-10 A1, A2, A3, H1)', () => {
  it('shows skeleton rows while loading', () => {
    deployApi.getProject.mockReturnValue(new Promise(() => undefined));
    deployApi.listEnvironments.mockReturnValue(new Promise(() => undefined));
    deployApi.listServices.mockReturnValue(new Promise(() => undefined));
    renderPage();
    expect(screen.getByTestId('project-loading')).toBeInTheDocument();
  });

  it('lists environments with their services, linking each service', async () => {
    seed();
    renderPage();
    const production = await screen.findByTestId(`environment-section-${PROD_ID}`);
    expect(production).toHaveAttribute('id', `environment-${PROD_ID}`);
    expect(within(production).getByRole('heading', { name: 'production' })).toBeInTheDocument();
    const row = within(production).getByTestId(`service-row-${SERVICE_ID}`);
    expect(row).toHaveTextContent('api');
    expect(row).toHaveTextContent('nginx:1.27');
    expect(within(row).getByRole('link')).toHaveAttribute('href', `/projects/${PROJECT_ID}/services/${SERVICE_ID}`);
    const staging = screen.getByTestId(`environment-section-${STAGING_ID}`);
    expect(staging).toHaveTextContent('No services in this environment yet.');
    expect(screen.getByRole('heading', { name: 'Billing' })).toBeInTheDocument();
  });

  // 13-20 A3: ListRow's two truncating spans shrink in proportion to their content, so a
  // 300-char repository URL squeezed the name "web" down to "w". The source is capped at a share
  // of the row (container units), leaving the name its room; both truncate with an ellipsis and
  // keep their full text in a title.
  it('keeps a service name readable next to a very long repository URL', async () => {
    const repositoryUrl = `https://github.com/acme/${'x'.repeat(300)}.git`;
    seed({
      services: [{ ...service(SERVICE_ID, PROD_ID, 'web'), sourceType: 'git', imageRef: null, repositoryUrl, branch: 'main' }],
    });
    renderPage();
    const row = await screen.findByTestId(`service-row-${SERVICE_ID}`);

    const name = within(row).getByText('web');
    expect(name).toHaveAttribute('title', 'web');
    expect(name.parentElement?.className.split(/\s+/)).toContain('truncate');

    const source = within(row).getByTitle(`${repositoryUrl} · main`);
    expect(source.className.split(/\s+/)).toEqual(expect.arrayContaining(['block', 'truncate', 'max-w-[55cqw]']));
    expect(row.closest('.\\@container')).not.toBeNull();
  });

  it('shows an empty state with one action when there are no environments', async () => {
    seed({ environments: [], services: [] });
    const user = renderPage();
    const empty = await screen.findByTestId('environments-empty');
    await user.click(within(empty).getByRole('button', { name: 'New environment' }));
    expect(await screen.findByTestId('environment-sheet')).toBeInTheDocument();
  });

  it('shows not found for a missing project or an unsafe id', async () => {
    deployApi.getProject.mockReturnValue(failure('NOT_FOUND'));
    deployApi.listEnvironments.mockReturnValue(failure('NOT_FOUND'));
    deployApi.listServices.mockReturnValue(failure('NOT_FOUND'));
    renderPage();
    expect(await screen.findByTestId('project-not-found')).toBeInTheDocument();
  });

  it('never fetches with an unsafe id', () => {
    nav.params = { projectId: '..%2Fservers' };
    renderPage();
    expect(screen.getByTestId('project-not-found')).toBeInTheDocument();
    expect(deployApi.getProject).not.toHaveBeenCalled();
  });

  it('shows a fixed error banner with a retry', async () => {
    deployApi.getProject.mockReturnValue(failure('INTERNAL_ERROR'));
    deployApi.listEnvironments.mockReturnValue(ok({ items: [] }));
    deployApi.listServices.mockReturnValue(ok({ items: [] }));
    renderPage();
    const banner = await screen.findByTestId('project-error-banner');
    expect(banner).toHaveTextContent('INTERNAL_ERROR');
    expect(banner).not.toHaveTextContent('raw server text');
  });

  it('creates an environment from the toolbar, suggesting names the project does not use yet', async () => {
    seed();
    deployApi.createEnvironment.mockReturnValue(failure('ENVIRONMENT_NAME_TAKEN'));
    const user = renderPage();
    await user.click(await screen.findByTestId('project-new-environment-button'));
    await screen.findByTestId('environment-sheet');
    expect(screen.queryByTestId('environment-suggestion-production')).not.toBeInTheDocument();
    expect(screen.getByTestId('environment-suggestion-development')).toBeInTheDocument();
    await user.type(screen.getByTestId('environment-sheet-name'), 'qa');
    await user.click(screen.getByTestId('environment-sheet-submit'));
    expect(await screen.findByText(ENVIRONMENT_NAME_TAKEN_COPY)).toBeInTheDocument();
    expect(deployApi.createEnvironment).toHaveBeenCalledWith(PROJECT_ID, { name: 'qa' });
  });

  it('deletes an empty environment after typing its exact name and refreshes the sidebar', async () => {
    seed();
    deployApi.deleteEnvironment.mockReturnValue(ok({ ok: true, environmentId: STAGING_ID }));
    const changed = vi.fn();
    const unsubscribe = subscribeProjectsChanged(changed);
    const user = renderPage();
    const dialog = await openEnvironmentDelete(user, STAGING_ID);
    const confirm = within(dialog).getByRole('button', { name: 'Delete environment' });
    await user.type(within(dialog).getByRole('textbox'), 'Staging');
    expect(confirm).toBeDisabled();
    await user.clear(within(dialog).getByRole('textbox'));
    await user.type(within(dialog).getByRole('textbox'), 'staging');
    // The server no longer returns staging once it is deleted (the projects-changed bus refetches).
    deployApi.listEnvironments.mockImplementation(() => ok({ items: [environment(PROD_ID, 'production')] }));
    await user.click(confirm);
    await waitFor(() => {
      expect(screen.queryByTestId(`environment-section-${STAGING_ID}`)).not.toBeInTheDocument();
    });
    expect(deployApi.deleteEnvironment).toHaveBeenCalledTimes(1);
    expect(deployApi.deleteEnvironment).toHaveBeenCalledWith(PROJECT_ID, STAGING_ID, 'staging');
    expect(changed).toHaveBeenCalled();
    unsubscribe();
  });

  it('shows the ENVIRONMENT_NOT_EMPTY recovery, never a raw error', async () => {
    seed();
    deployApi.deleteEnvironment.mockReturnValue(failure('ENVIRONMENT_NOT_EMPTY'));
    const user = renderPage();
    const dialog = await openEnvironmentDelete(user, PROD_ID);
    await user.type(within(dialog).getByRole('textbox'), 'production');
    await user.click(within(dialog).getByRole('button', { name: 'Delete environment' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(ENVIRONMENT_NOT_EMPTY_COPY);
    expect(dialog).not.toHaveTextContent('raw server text');
    expect(screen.getByTestId(`environment-section-${PROD_ID}`)).toBeInTheDocument();
  });

  it('treats a 404 on environment delete as done and refreshes the list', async () => {
    seed();
    deployApi.deleteEnvironment.mockReturnValue(failure('NOT_FOUND'));
    const user = renderPage();
    const dialog = await openEnvironmentDelete(user, STAGING_ID);
    const fetchesBefore = deployApi.listEnvironments.mock.calls.length;
    deployApi.listEnvironments.mockImplementation(() => ok({ items: [environment(PROD_ID, 'production')] }));
    await user.type(within(dialog).getByRole('textbox'), 'staging');
    await user.click(within(dialog).getByRole('button', { name: 'Delete environment' }));
    await waitFor(() => {
      expect(screen.queryByTestId('environment-delete-dialog')).not.toBeInTheDocument();
    });
    expect(screen.queryByTestId(`environment-section-${STAGING_ID}`)).not.toBeInTheDocument();
    await waitFor(() => {
      expect(deployApi.listEnvironments.mock.calls.length).toBeGreaterThan(fetchesBefore);
    });
  });

  it('returns focus to the environment menu when the delete dialog is dismissed with Escape', async () => {
    seed();
    const user = renderPage();
    await openEnvironmentDelete(user, STAGING_ID);
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByTestId('environment-delete-dialog')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByTestId(`environment-menu-${STAGING_ID}`)).toHaveFocus();
    });
  });

  it('goes back to Projects after the archived project is deleted', async () => {
    seed();
    deployApi.getProject.mockImplementation(() => ok(project(STAMP)));
    deployApi.deleteProject.mockReturnValue(ok({ ok: true, projectId: PROJECT_ID }));
    const user = renderPage();
    await user.click(await screen.findByTestId('project-delete-button'));
    const dialog = await screen.findByTestId('project-delete-dialog');
    await user.type(within(dialog).getByRole('textbox'), 'Billing');
    await user.click(within(dialog).getByRole('button', { name: 'Delete project' }));
    await waitFor(() => {
      expect(nav.push).toHaveBeenCalledWith('/projects');
    });
  });
});

describe('Project page: New service per environment (13-12 A6)', () => {
  it('has a New service action per environment that opens ServiceSheet in create mode for that environment', async () => {
    seed();
    const user = renderPage();

    expect(await screen.findByTestId(`new-service-${PROD_ID}`)).toHaveTextContent('New service');
    expect(screen.getByTestId(`new-service-${STAGING_ID}`)).toBeInTheDocument();
    expect(screen.queryByTestId('service-sheet')).not.toBeInTheDocument();

    await user.click(screen.getByTestId(`new-service-${STAGING_ID}`));

    const sheet = await screen.findByTestId('service-sheet');
    expect(sheet).toHaveAttribute('data-mode', 'create');
    expect(sheet).toHaveAttribute('data-environment', STAGING_ID);
    expect(apiClient.apiGet).toHaveBeenCalledWith('/api/servers');
    await waitFor(() => {
      expect(within(sheet).getByTestId('service-sheet-servers')).toHaveTextContent(SERVER_ID);
    });
  });

  it('updates the services list and the sidebar after a save, without a reload', async () => {
    seed();
    const changed = vi.fn();
    const unsubscribe = subscribeProjectsChanged(changed);
    const user = renderPage();

    await user.click(await screen.findByTestId(`new-service-${STAGING_ID}`));
    const callsBefore = deployApi.listServices.mock.calls.length;
    deployApi.listServices.mockImplementation(() =>
      ok({ items: [service(SERVICE_ID, PROD_ID, 'api'), service(NEW_SERVICE_ID, STAGING_ID, 'worker')] }),
    );
    await user.click(screen.getByRole('button', { name: 'Save stub' }));

    expect(await screen.findByTestId(`service-row-${NEW_SERVICE_ID}`)).toHaveTextContent('worker');
    expect(within(screen.getByTestId(`environment-services-${STAGING_ID}`)).getByText('worker')).toBeInTheDocument();
    expect(deployApi.listServices.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(changed).toHaveBeenCalled();
    expect(screen.queryByTestId('service-sheet')).not.toBeInTheDocument();
    unsubscribe();
  });
});
