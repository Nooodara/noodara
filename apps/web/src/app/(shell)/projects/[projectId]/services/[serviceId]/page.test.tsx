import { act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderUi, screen, userEvent, waitFor } from '@noodara/ui/testing';
import { subscribeProjectsChanged } from '../../../../../../components/ProjectNav';
import type { DeploymentView, ServiceView } from '../../../../../../lib/deploy-api';
import type { DeployEntityEvent } from '../../../../../../lib/server-events';
import { PROJECT_ARCHIVED_DEPLOY_COPY } from '../../../../../../lib/service-status-copy';
import { ShellContext, type ShellContextValue } from '../../../../../../lib/shell-context';
import ServicePage from './page';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ENVIRONMENT_ID = '22222222-2222-4222-8222-222222222222';
const SERVICE_ID = '44444444-4444-4444-8444-444444444444';
const SERVER_ID = '55555555-5555-4555-8555-555555555555';
const DEPLOYMENT_ID = '77777777-7777-4777-8777-777777777777';
const STAMP = '2026-10-06T00:00:00.000Z';
const LATER = '2026-10-06T01:00:00.000Z';

const nav = vi.hoisted(() => ({ params: { projectId: '', serviceId: '' }, push: vi.fn() }));
const deployApi = vi.hoisted(() => ({
  getProject: vi.fn(),
  getService: vi.fn(),
  listDeployments: vi.fn(),
  deployService: vi.fn(),
  cancelDeployment: vi.fn(),
  redeployService: vi.fn(),
  runServiceOperation: vi.fn(),
  deleteService: vi.fn(),
}));
const apiClient = vi.hoisted(() => ({ apiGet: vi.fn() }));
const saved = vi.hoisted((): { current: unknown } => ({ current: null }));

vi.mock('next/navigation', () => ({
  useParams: () => nav.params,
  useRouter: () => ({ push: nav.push, replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('../../../../../../lib/deploy-api', () => ({
  getProject: (id: string) => deployApi.getProject(id) as unknown,
  getService: (projectId: string, id: string) => deployApi.getService(projectId, id) as unknown,
  listDeployments: (id: string, query: unknown) => deployApi.listDeployments(id, query) as unknown,
  deployService: (id: string) => deployApi.deployService(id) as unknown,
  cancelDeployment: (id: string) => deployApi.cancelDeployment(id) as unknown,
  redeployService: (projectId: string, id: string) => deployApi.redeployService(projectId, id) as unknown,
  runServiceOperation: (projectId: string, id: string, operation: string) =>
    deployApi.runServiceOperation(projectId, id, operation) as unknown,
  deleteService: (projectId: string, id: string, confirmName: string) =>
    deployApi.deleteService(projectId, id, confirmName) as unknown,
}));
vi.mock('../../../../../../lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  apiGet: (path: string) => apiClient.apiGet(path) as unknown,
}));
vi.mock('../../../../../../lib/require-session', () => ({ requireSession: () => undefined }));
// ServiceSheet itself is covered by ServiceSheet.test.tsx; here only how the page opens it and applies a save.
vi.mock('../../../../../../components/ServiceSheet', () => ({
  REDEPLOY_NEEDED_COPY: 'Redeploy to apply.',
  ServiceSheet: (props: {
    open: boolean;
    service?: { name: string };
    servers: readonly { id: string }[];
    onSaved?: (service: unknown, info: { requiresRedeploy: boolean }) => void;
    onOpenChange: (open: boolean) => void;
  }) =>
    props.open ? (
      <div data-testid="service-sheet" data-mode={props.service === undefined ? 'create' : 'edit'} data-name={props.service?.name}>
        <button
          type="button"
          onClick={() => {
            props.onSaved?.(saved.current, { requiresRedeploy: true });
            props.onOpenChange(false);
          }}
        >
          Save stub
        </button>
      </div>
    ) : null,
}));

const listeners = new Set<(event: DeployEntityEvent) => void>();

const SHELL_CONTEXT: ShellContextValue = {
  connected: true,
  subscribe: () => () => undefined,
  subscribeDeploy: (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  subscribeDeploymentLog: () => () => undefined,
  registerResync: () => () => undefined,
  close: () => undefined,
  closedByCaller: false,
  mobileNavOpen: false,
  toggleMobileNav: () => undefined,
  closeMobileNav: () => undefined,
};

function emit(event: DeployEntityEvent) {
  act(() => {
    for (const listener of listeners) listener(event);
  });
}

function project(archivedAt: string | null = null) {
  return { id: PROJECT_ID, name: 'Billing', slug: 'billing', description: null, archivedAt, createdAt: STAMP, updatedAt: STAMP };
}

function service(overrides: Partial<ServiceView> = {}): ServiceView {
  return {
    id: SERVICE_ID,
    projectId: PROJECT_ID,
    environmentId: ENVIRONMENT_ID,
    serverId: SERVER_ID,
    name: 'api',
    sourceType: 'image',
    repositoryUrl: null,
    branch: null,
    buildContext: null,
    dockerfilePath: null,
    buildTarget: null,
    imageRef: 'nginx:1.27',
    internalPort: 80,
    publishedPort: 8080,
    status: 'RUNNING',
    createdAt: STAMP,
    updatedAt: STAMP,
    ...overrides,
  };
}

function deployment(status: string): DeploymentView {
  return {
    id: DEPLOYMENT_ID,
    serviceId: SERVICE_ID,
    status,
    trigger: 'manual',
    triggeredBy: null,
    source: {
      sourceType: 'image',
      repositoryUrl: null,
      branch: null,
      buildContext: null,
      dockerfilePath: null,
      buildTarget: null,
      imageRef: 'nginx:1.27',
      internalPort: 80,
      publishedPort: null,
    },
    commitSha: null,
    previousDeploymentId: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    errorCode: null,
    errorMessage: null,
    createdAt: STAMP,
    updatedAt: STAMP,
  } as DeploymentView;
}

const ok = <T,>(data: T) => Promise.resolve({ ok: true, data });
const failure = (code: string) => Promise.resolve({ ok: false, code, message: 'raw server text', unauthorized: false });

function seed({ archivedAt = null as string | null, current = service(), deployments = [] as DeploymentView[] } = {}) {
  deployApi.getProject.mockImplementation(() => ok(project(archivedAt)));
  deployApi.getService.mockImplementation(() => ok(current));
  deployApi.listDeployments.mockImplementation(() => ok({ items: deployments, nextCursor: null }));
  apiClient.apiGet.mockImplementation(() => ok({ items: [{ id: SERVER_ID, name: 'edge-1' }] }));
}

function renderPage() {
  const user = userEvent.setup();
  renderUi(
    <ShellContext.Provider value={SHELL_CONTEXT}>
      <ServicePage />
    </ShellContext.Provider>,
  );
  return user;
}

beforeEach(() => {
  nav.params = { projectId: PROJECT_ID, serviceId: SERVICE_ID };
  nav.push.mockReset();
  listeners.clear();
  for (const fn of Object.values(deployApi)) fn.mockReset();
  apiClient.apiGet.mockReset();
  saved.current = null;
});

describe('Service page (13-12 A1, A3, A5)', () => {
  it('shows the status the API derived, with the service facts and its server', async () => {
    seed({ current: service({ status: 'STOPPED' as ServiceView['status'] }) });
    renderPage();

    expect(await screen.findByTestId('service-status-pill')).toHaveTextContent('Stopped');
    expect(screen.getByTestId('service-fact-image')).toHaveTextContent('nginx:1.27');
    await waitFor(() => {
      expect(screen.getByTestId('service-fact-server')).toHaveTextContent('edge-1');
    });
    expect(deployApi.getService).toHaveBeenCalledWith(PROJECT_ID, SERVICE_ID);
  });

  it('follows service.updated instead of computing a status itself', async () => {
    seed();
    renderPage();
    await screen.findByTestId('service-status-pill');

    emit({ type: 'service.updated', service: service({ status: 'UNKNOWN' as ServiceView['status'], updatedAt: LATER }) });

    expect(screen.getByTestId('service-status-pill')).toHaveTextContent('Unknown');
    // A stale snapshot never overwrites a newer one.
    emit({ type: 'service.updated', service: service({ status: 'RUNNING' as ServiceView['status'], updatedAt: STAMP }) });
    expect(screen.getByTestId('service-status-pill')).toHaveTextContent('Unknown');
  });

  it('shows Cancel for the active deployment in the history', async () => {
    seed({ current: service({ status: 'DEPLOYING' as ServiceView['status'] }), deployments: [deployment('BUILDING')] });
    renderPage();

    expect(await screen.findByTestId('service-cancel')).toBeEnabled();
    expect(screen.getByTestId('service-deploy')).toBeDisabled();
  });

  it('disables Deploy in an archived project and says why', async () => {
    seed({ archivedAt: LATER });
    renderPage();

    expect(await screen.findByTestId('service-deploy')).toBeDisabled();
    expect(screen.getByTestId('service-archived-note')).toHaveTextContent(PROJECT_ARCHIVED_DEPLOY_COPY);
  });

  it('adds a deployment it queued to the history at once', async () => {
    seed();
    deployApi.deployService.mockReturnValue(ok(deployment('QUEUED')));
    const user = renderPage();

    await user.click(await screen.findByTestId('service-deploy'));

    expect(await screen.findByTestId(`deployment-row-${DEPLOYMENT_ID}`)).toHaveAttribute('data-status', 'QUEUED');
  });

  it('shows not found for a missing service', async () => {
    seed();
    deployApi.getService.mockImplementation(() => failure('NOT_FOUND'));
    renderPage();

    expect(await screen.findByTestId('service-not-found')).toBeInTheDocument();
  });

  it('shows not found for an unsafe id without fetching', () => {
    nav.params = { projectId: PROJECT_ID, serviceId: '../etc' };
    seed();
    renderPage();

    expect(screen.getByTestId('service-not-found')).toBeInTheDocument();
    expect(deployApi.getService).not.toHaveBeenCalled();
  });

  it('shows that the service was deleted on service.deleted', async () => {
    seed();
    renderPage();
    await screen.findByTestId('service-status-pill');

    emit({ type: 'service.deleted', id: SERVICE_ID });

    expect(screen.getByTestId('service-deleted')).toBeInTheDocument();
  });
});

describe('Service page edit (13-12 A6)', () => {
  it('opens ServiceSheet in edit mode and applies the save without a reload', async () => {
    seed();
    saved.current = service({ name: 'api-v2', updatedAt: LATER });
    const changed = vi.fn();
    const unsubscribe = subscribeProjectsChanged(changed);
    const user = renderPage();

    await user.click(await screen.findByTestId('service-edit'));
    const sheet = await screen.findByTestId('service-sheet');
    expect(sheet).toHaveAttribute('data-mode', 'edit');
    expect(sheet).toHaveAttribute('data-name', 'api');
    await user.click(screen.getByRole('button', { name: 'Save stub' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'api-v2' })).toBeInTheDocument();
    expect(screen.getByTestId('service-redeploy-needed')).toHaveTextContent('Redeploy to apply.');
    expect(changed).toHaveBeenCalled();
    expect(screen.queryByTestId('service-sheet')).not.toBeInTheDocument();
    unsubscribe();
  });
});
