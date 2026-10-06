import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';
import { renderUi, screen, userEvent, waitFor, within } from '@noodara/ui/testing';
import type { DeploymentView, ServiceView } from '../lib/deploy-api';
import {
  DEPLOYMENT_IN_PROGRESS_COPY,
  DEPLOYMENT_NOT_CANCELLABLE_COPY,
  PROJECT_ARCHIVED_DEPLOY_COPY,
  SERVICE_ACTION_FAILED_COPY,
} from '../lib/service-status-copy';
import { ShellContext, type ShellContextValue } from '../lib/shell-context';
import { ServiceToolbar } from './ServiceToolbar';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const SERVICE_ID = '44444444-4444-4444-8444-444444444444';
const DEPLOYMENT_ID = '77777777-7777-4777-8777-777777777777';
const STAMP = '2026-10-06T00:00:00.000Z';

const deployApi = vi.hoisted(() => ({
  deployService: vi.fn(),
  cancelDeployment: vi.fn(),
  redeployService: vi.fn(),
  runServiceOperation: vi.fn(),
  deleteService: vi.fn(),
}));

vi.mock('../lib/deploy-api', () => ({
  deployService: (id: string) => deployApi.deployService(id) as unknown,
  cancelDeployment: (id: string) => deployApi.cancelDeployment(id) as unknown,
  redeployService: (projectId: string, id: string) => deployApi.redeployService(projectId, id) as unknown,
  runServiceOperation: (projectId: string, id: string, operation: string) =>
    deployApi.runServiceOperation(projectId, id, operation) as unknown,
  deleteService: (projectId: string, id: string, confirmName: string) =>
    deployApi.deleteService(projectId, id, confirmName) as unknown,
}));
vi.mock('../lib/require-session', () => ({ requireSession: () => undefined }));

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

function service(overrides: Partial<ServiceView> = {}): ServiceView {
  return {
    id: SERVICE_ID,
    projectId: PROJECT_ID,
    environmentId: '22222222-2222-4222-8222-222222222222',
    serverId: '55555555-5555-4555-8555-555555555555',
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

function deployment(status: string, id = DEPLOYMENT_ID): DeploymentView {
  return {
    id,
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

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface RenderOptions {
  readonly service?: ServiceView;
  readonly archived?: boolean;
  readonly activeDeployment?: DeploymentView | null;
}

function renderToolbar({ service: target = service(), archived = false, activeDeployment = null }: RenderOptions = {}) {
  const user = userEvent.setup();
  const props = {
    onDeploymentChange: vi.fn(),
    onServiceChange: vi.fn(),
    onRefresh: vi.fn(),
    onEdit: vi.fn(),
    onDeleted: vi.fn(),
  };
  const view = renderUi(
    <ShellContext.Provider value={SHELL_CONTEXT}>
      <ServiceToolbar service={target} projectName="Billing" archived={archived} activeDeployment={activeDeployment} {...props} />
    </ShellContext.Provider>,
  );
  const rerender = (next: RenderOptions) => {
    view.rerender(
      <ShellContext.Provider value={SHELL_CONTEXT}>
        <ServiceToolbar
          service={next.service ?? target}
          projectName="Billing"
          archived={next.archived ?? archived}
          activeDeployment={next.activeDeployment === undefined ? activeDeployment : next.activeDeployment}
          {...props}
        />
      </ShellContext.Provider>,
    );
  };
  return { user, rerender, ...props };
}

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId('service-actions-menu'));
}

beforeEach(() => {
  for (const fn of Object.values(deployApi)) fn.mockReset();
});

describe('ServiceToolbar status (13-12 A1)', () => {
  it.each([
    ['RUNNING', 'Running', 'ok'],
    ['STOPPED', 'Stopped', 'idle'],
    ['DEPLOYING', 'Deploying', 'warn'],
    ['FAILED', 'Failed', 'error'],
    ['NEVER_DEPLOYED', 'Never deployed', 'idle'],
  ])('shows the derived %s status as a word with its tone and meaning', (status, word, tone) => {
    renderToolbar({ service: service({ status: status as ServiceView['status'] }) });

    const pill = screen.getByTestId('service-status-pill');
    expect(pill).toHaveTextContent(word);
    expect(pill).toHaveAttribute('data-tone', tone);
    expect(pill.getAttribute('title')).not.toBe('');
  });

  it('shows UNKNOWN honestly, saying the container could not be checked', () => {
    renderToolbar({ service: service({ status: 'UNKNOWN' as ServiceView['status'] }) });

    const pill = screen.getByTestId('service-status-pill');
    expect(pill).toHaveTextContent('Unknown');
    expect(pill).toHaveAttribute('data-tone', 'idle');
    expect(pill.getAttribute('title')).toMatch(/couldn't check the container/);
  });

  it('never presents an unrecognized value as healthy', () => {
    renderToolbar({ service: service({ status: 'banana' as ServiceView['status'] }) });

    expect(screen.getByTestId('service-status-pill')).toHaveTextContent('Unknown');
  });
});

describe('ServiceToolbar actions (13-12 A2)', () => {
  it('has exactly one primary action, Deploy', () => {
    renderToolbar();

    const primaries = screen.getAllByRole('button').filter((button) => button.getAttribute('data-variant') === 'primary');
    expect(primaries).toHaveLength(1);
    expect(primaries[0]).toHaveTextContent('Deploy');
  });

  it('keeps redeploy, stop, restart, remove container and delete service in the overflow menu', async () => {
    const { user } = renderToolbar();

    await openMenu(user);

    const items = (await screen.findAllByRole('menuitem')).map((item) => item.textContent);
    expect(items).toEqual(['Redeploy', 'Stop', 'Restart', 'Remove container', 'Delete service']);
  });

  it('deploys and reports the queued deployment', async () => {
    const queued = deployment('QUEUED');
    deployApi.deployService.mockReturnValue(ok(queued));
    const { user, onDeploymentChange } = renderToolbar();

    await user.click(screen.getByTestId('service-deploy'));

    await waitFor(() => {
      expect(onDeploymentChange).toHaveBeenCalledWith(queued);
    });
    expect(deployApi.deployService).toHaveBeenCalledWith(SERVICE_ID);
  });

  it('redeploys from the menu', async () => {
    const queued = deployment('QUEUED');
    deployApi.redeployService.mockReturnValue(ok(queued));
    const { user, onDeploymentChange } = renderToolbar();

    await openMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: 'Redeploy' }));

    await waitFor(() => {
      expect(onDeploymentChange).toHaveBeenCalledWith(queued);
    });
    expect(deployApi.redeployService).toHaveBeenCalledWith(PROJECT_ID, SERVICE_ID);
  });

  it.each([
    ['Stop', 'stop'],
    ['Restart', 'restart'],
    ['Remove container', 'remove'],
  ])('runs %s from the menu and applies the returned service', async (label, operation) => {
    const next = service({ status: 'STOPPED' as ServiceView['status'], updatedAt: '2026-10-06T01:00:00.000Z' });
    deployApi.runServiceOperation.mockReturnValue(ok({ service: next }));
    const { user, onServiceChange } = renderToolbar();

    await openMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: label }));

    await waitFor(() => {
      expect(onServiceChange).toHaveBeenCalledWith(next);
    });
    expect(deployApi.runServiceOperation).toHaveBeenCalledWith(PROJECT_ID, SERVICE_ID, operation);
  });

  it('shows fixed copy for a failed operation, never the server text', async () => {
    deployApi.runServiceOperation.mockReturnValue(failure('INTERNAL'));
    const { user } = renderToolbar();

    await openMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: 'Stop' }));

    expect(await screen.findByTestId('service-toolbar-error')).toHaveTextContent(SERVICE_ACTION_FAILED_COPY);
    expect(screen.queryByText('raw server text')).not.toBeInTheDocument();
  });

  it('deletes the service only after typing its exact name', async () => {
    deployApi.deleteService.mockReturnValue(ok({ ok: true }));
    const { user, onDeleted } = renderToolbar();

    await openMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: 'Delete service' }));
    const dialog = await screen.findByTestId('service-delete-dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Delete service' });
    await user.type(within(dialog).getByRole('textbox'), 'API');
    expect(confirm).toBeDisabled();
    await user.clear(within(dialog).getByRole('textbox'));
    await user.type(within(dialog).getByRole('textbox'), 'api');
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    await waitFor(() => {
      expect(onDeleted).toHaveBeenCalledTimes(1);
    });
    expect(deployApi.deleteService).toHaveBeenCalledWith(PROJECT_ID, SERVICE_ID, 'api');
  });

  it('opens edit', async () => {
    const { user, onEdit } = renderToolbar();

    await user.click(screen.getByTestId('service-edit'));

    expect(onEdit).toHaveBeenCalledTimes(1);
  });
});

describe('ServiceToolbar active deployment (13-12 A3)', () => {
  it('shows Cancel while a deployment is active and disables Deploy', () => {
    renderToolbar({ activeDeployment: deployment('BUILDING') });

    expect(screen.getByTestId('service-cancel')).toHaveTextContent('Cancel deploy');
    expect(screen.getByTestId('service-cancel')).toBeEnabled();
    expect(screen.getByTestId('service-deploy')).toBeDisabled();
  });

  it('shows no Cancel without an active deployment', () => {
    renderToolbar();

    expect(screen.queryByTestId('service-cancel')).not.toBeInTheDocument();
  });

  it('shows no Cancel for a finished deployment', () => {
    renderToolbar({ activeDeployment: deployment('SUCCESS') });

    expect(screen.queryByTestId('service-cancel')).not.toBeInTheDocument();
  });

  it('cancels the active deployment', async () => {
    const cancelled = deployment('CANCELLED');
    deployApi.cancelDeployment.mockReturnValue(ok(cancelled));
    const { user, onDeploymentChange } = renderToolbar({ activeDeployment: deployment('BUILDING') });

    await user.click(screen.getByTestId('service-cancel'));

    await waitFor(() => {
      expect(onDeploymentChange).toHaveBeenCalledWith(cancelled);
    });
    expect(deployApi.cancelDeployment).toHaveBeenCalledWith(DEPLOYMENT_ID);
  });

  it('shows the DEPLOYMENT_IN_PROGRESS recovery copy', async () => {
    deployApi.deployService.mockReturnValue(failure('DEPLOYMENT_IN_PROGRESS'));
    const { user } = renderToolbar();

    await user.click(screen.getByTestId('service-deploy'));

    const notice = await screen.findByTestId('service-toolbar-notice');
    expect(notice).toHaveTextContent(DEPLOYMENT_IN_PROGRESS_COPY);
    expect(notice).toHaveAttribute('role', 'status');
    expect(screen.queryByTestId('service-toolbar-error')).not.toBeInTheDocument();
  });

  it('shows the DEPLOYMENT_NOT_CANCELLABLE recovery copy and refreshes', async () => {
    deployApi.cancelDeployment.mockReturnValue(failure('DEPLOYMENT_NOT_CANCELLABLE'));
    const { user, onRefresh } = renderToolbar({ activeDeployment: deployment('DEPLOYING') });

    await user.click(screen.getByTestId('service-cancel'));

    expect(await screen.findByTestId('service-toolbar-notice')).toHaveTextContent(DEPLOYMENT_NOT_CANCELLABLE_COPY);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});

describe('ServiceToolbar archived project (13-12 A5)', () => {
  it('disables Deploy and states the reason', async () => {
    const { user } = renderToolbar({ archived: true });

    const deploy = screen.getByTestId('service-deploy');
    expect(deploy).toBeDisabled();
    const note = screen.getByTestId('service-archived-note');
    expect(note).toHaveTextContent(PROJECT_ARCHIVED_DEPLOY_COPY);
    expect(deploy).toHaveAttribute('aria-describedby', note.id);

    await user.click(deploy);
    expect(deployApi.deployService).not.toHaveBeenCalled();
  });
});

describe('ServiceToolbar action safety (13-12 H1)', () => {
  it('enqueues exactly one deployment on a double click', async () => {
    const pending = deferred<{ ok: true; data: DeploymentView }>();
    deployApi.deployService.mockReturnValue(pending.promise);
    const { user, onDeploymentChange } = renderToolbar();

    await user.dblClick(screen.getByTestId('service-deploy'));
    await user.click(screen.getByTestId('service-deploy'));

    expect(deployApi.deployService).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve({ ok: true, data: deployment('QUEUED') });
      await pending.promise;
    });
    expect(onDeploymentChange).toHaveBeenCalledTimes(1);
  });

  it('disables Deploy, Edit and the overflow menu while a request is pending', async () => {
    const pending = deferred<{ ok: true; data: DeploymentView }>();
    deployApi.deployService.mockReturnValue(pending.promise);
    const { user } = renderToolbar();

    await user.click(screen.getByTestId('service-deploy'));

    const actions = screen.getByTestId('service-actions');
    expect(actions).toBeDisabled();
    expect(actions).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('service-actions-menu')).toBeDisabled();
    expect(screen.getByTestId('service-edit')).toBeDisabled();

    await act(async () => {
      pending.resolve({ ok: true, data: deployment('QUEUED') });
      await pending.promise;
    });
    await waitFor(() => {
      expect(screen.getByTestId('service-actions')).toBeEnabled();
    });
  });

  it('runs one overflow operation at a time', async () => {
    const pending = deferred<{ ok: true; data: { service: ServiceView } }>();
    deployApi.runServiceOperation.mockReturnValue(pending.promise);
    const { user } = renderToolbar();

    await openMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: 'Restart' }));
    expect(screen.getByTestId('service-actions-menu')).toBeDisabled();
    await user.click(screen.getByTestId('service-deploy'));

    expect(deployApi.runServiceOperation).toHaveBeenCalledTimes(1);
    expect(deployApi.deployService).not.toHaveBeenCalled();
    await act(async () => {
      pending.resolve({ ok: true, data: { service: service() } });
      await pending.promise;
    });
  });

  it('refreshes state on a 409 DEPLOYMENT_IN_PROGRESS race instead of showing an error', async () => {
    deployApi.deployService.mockReturnValue(failure('DEPLOYMENT_IN_PROGRESS'));
    const { user, onRefresh } = renderToolbar();

    await user.click(screen.getByTestId('service-deploy'));

    await waitFor(() => {
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId('service-toolbar-error')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('service-toolbar-notice')).toHaveLength(1);
    // No retry loop: one request, one refresh.
    expect(deployApi.deployService).toHaveBeenCalledTimes(1);
  });

  it('makes a second click on Cancel a no-op', async () => {
    deployApi.cancelDeployment.mockReturnValue(ok(deployment('BUILDING')));
    const { user, onDeploymentChange } = renderToolbar({ activeDeployment: deployment('BUILDING') });

    await user.click(screen.getByTestId('service-cancel'));
    await waitFor(() => {
      expect(onDeploymentChange).toHaveBeenCalledTimes(1);
    });
    const cancel = screen.getByTestId('service-cancel');
    expect(cancel).toBeDisabled();
    expect(cancel).toHaveTextContent('Cancelling…');
    await user.click(cancel);

    expect(deployApi.cancelDeployment).toHaveBeenCalledTimes(1);
  });

  it('drops a cancel double click while the first is pending', async () => {
    const pending = deferred<{ ok: true; data: DeploymentView }>();
    deployApi.cancelDeployment.mockReturnValue(pending.promise);
    renderToolbar({ activeDeployment: deployment('QUEUED') });
    const cancel = screen.getByTestId('service-cancel');

    act(() => {
      cancel.click();
      cancel.click();
    });

    expect(deployApi.cancelDeployment).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve({ ok: true, data: deployment('CANCELLED') });
      await pending.promise;
    });
  });

  it('removes Cancel once the deployment is no longer cancellable', () => {
    const { rerender } = renderToolbar({ activeDeployment: deployment('BUILDING') });
    expect(screen.getByTestId('service-cancel')).toBeInTheDocument();

    rerender({ activeDeployment: deployment('FAILED') });

    expect(screen.queryByTestId('service-cancel')).not.toBeInTheDocument();
  });
});
