import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderUi, screen, userEvent, waitFor } from '@noodara/ui/testing';
import type { ServerView } from '../lib/api-client';
import type { ServiceView } from '../lib/deploy-api';
import { PORT_IN_USE_COPY, BUILDKIT_UNAVAILABLE_COPY } from '../lib/service-form';
import { NO_SERVERS_COPY, REDEPLOY_NEEDED_COPY, SERVICE_SAVE_FAILED_COPY, ServiceSheet, V02_LIMIT_COPY } from './ServiceSheet';

// jsdom has no ResizeObserver; Radix RadioGroup inside a <form> calls it (see ServerSheet.test.tsx).
class ResizeObserverStub {
  observe(): void {
    return;
  }
  unobserve(): void {
    return;
  }
  disconnect(): void {
    return;
  }
}
type GlobalWithResizeObserver = typeof globalThis & { ResizeObserver?: typeof ResizeObserver };
(globalThis as GlobalWithResizeObserver).ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

const api = vi.hoisted(() => ({
  createService: vi.fn(),
  updateService: vi.fn(),
  getServiceCredentials: vi.fn(),
}));

vi.mock('../lib/deploy-api', () => ({
  createService: (...args: unknown[]) => api.createService(...args) as unknown,
  updateService: (...args: unknown[]) => api.updateService(...args) as unknown,
  getServiceCredentials: (...args: unknown[]) => api.getServiceCredentials(...args) as unknown,
  setRepositoryCredential: vi.fn(),
  setRegistryCredential: vi.fn(),
  removeServiceCredential: vi.fn(),
}));
vi.mock('../lib/require-session', () => ({ requireSession: () => undefined }));

const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const ENVIRONMENT_ID = '33333333-3333-4333-8333-333333333333';
const SERVER_A = '7d5c3a8e-2b1f-4c6d-9e0a-1f2b3c4d5e6f';
const SERVER_B = '8e6d4b9f-3c2a-4d7e-8f1b-2a3b4c5d6e7f';

function server(patch: Partial<ServerView>): ServerView {
  return { id: SERVER_A, name: 'alpha', host: '203.0.113.4', status: 'CONNECTED', dockerInstalled: true, ...patch } as ServerView;
}

const SERVERS: ServerView[] = [
  server({ id: SERVER_A, name: 'alpha' }),
  server({ id: SERVER_B, name: 'bravo', host: '203.0.113.5' }),
  server({ id: 'c', name: 'no-docker', dockerInstalled: false }),
  server({ id: 'd', name: 'unreachable', status: 'UNREACHABLE' }),
  server({ id: 'e', name: 'pending', status: 'PENDING', dockerInstalled: null }),
];

const SERVICE: ServiceView = {
  id: '11111111-1111-4111-8111-111111111111',
  projectId: PROJECT_ID,
  environmentId: ENVIRONMENT_ID,
  serverId: SERVER_A,
  name: 'web',
  sourceType: 'git',
  repositoryUrl: 'https://github.com/acme/web.git',
  branch: 'main',
  buildContext: '.',
  dockerfilePath: 'Dockerfile',
  buildTarget: null,
  imageRef: null,
  internalPort: 3000,
  publishedPort: null,
  status: 'RUNNING',
  createdAt: '2026-10-06T00:00:00.000Z',
  updatedAt: '2026-10-06T00:00:00.000Z',
};

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function renderSheet(options: { servers?: ServerView[]; service?: ServiceView } = {}) {
  const onSaved = vi.fn();
  const onOpenChange = vi.fn();
  renderUi(
    <ServiceSheet
      open
      onOpenChange={onOpenChange}
      projectId={PROJECT_ID}
      environmentId={ENVIRONMENT_ID}
      servers={options.servers ?? SERVERS}
      {...(options.service === undefined ? {} : { service: options.service })}
      onSaved={onSaved}
    />,
  );
  return { onSaved, onOpenChange, user: userEvent.setup() };
}

async function fillCreate(user: ReturnType<typeof userEvent.setup>, repositoryUrl = 'https://github.com/acme/web.git') {
  await user.type(screen.getByTestId('service-sheet-name'), 'web');
  await user.click(screen.getByRole('radio', { name: /alpha/ }));
  await user.type(screen.getByTestId('source-repositoryUrl'), repositoryUrl);
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.getServiceCredentials.mockResolvedValue({ ok: true, data: { repository: null, registry: null } });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('ServiceSheet: server picker (13-11 A2)', () => {
  it('lists only CONNECTED servers with Docker', () => {
    renderSheet();
    const names = screen.getAllByTestId('service-sheet-server').map((row) => row.textContent);
    expect(names).toEqual(['alpha203.0.113.4', 'bravo203.0.113.5']);
    expect(screen.queryByText('no-docker')).not.toBeInTheDocument();
    expect(screen.queryByText('unreachable')).not.toBeInTheDocument();
    expect(screen.queryByText('pending')).not.toBeInTheDocument();
  });

  it('explains how to connect one when none qualifies, and cannot submit', () => {
    renderSheet({ servers: [server({ id: 'c', name: 'no-docker', dockerInstalled: false })] });
    expect(screen.getByTestId('service-sheet-no-servers')).toHaveTextContent(NO_SERVERS_COPY);
    expect(screen.getByRole('link', { name: 'Go to Servers' })).toHaveAttribute('href', '/servers');
    expect(screen.queryAllByTestId('service-sheet-server')).toHaveLength(0);
    expect(screen.getByTestId('service-sheet-submit')).toBeDisabled();
  });

  it('preselects the only eligible server', () => {
    renderSheet({ servers: [server({ id: SERVER_A, name: 'alpha' })] });
    expect(screen.getByRole('radio', { name: /alpha/ })).toBeChecked();
  });

  it('asks for a server before sending', async () => {
    const { user } = renderSheet();
    await user.type(screen.getByTestId('service-sheet-name'), 'web');
    await user.type(screen.getByTestId('source-repositoryUrl'), 'https://github.com/acme/web.git');
    await user.click(screen.getByTestId('service-sheet-submit'));
    expect(screen.getByText('Choose a server to run this service on.')).toBeInTheDocument();
    expect(api.createService).not.toHaveBeenCalled();
  });
});

describe('ServiceSheet: create (A1, A4, H2, H3)', () => {
  it('creates a Git service with the environment and closes', async () => {
    api.createService.mockResolvedValue({ ok: true, data: SERVICE });
    const { user, onSaved, onOpenChange } = renderSheet();
    await fillCreate(user);
    await user.click(screen.getByTestId('service-sheet-submit'));

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledWith(SERVICE, { requiresRedeploy: false });
    });
    expect(api.createService).toHaveBeenCalledWith(PROJECT_ID, {
      environmentId: ENVIRONMENT_ID,
      name: 'web',
      serverId: SERVER_A,
      source: {
        kind: 'git',
        repositoryUrl: 'https://github.com/acme/web.git',
        branch: 'main',
        buildContext: '.',
        dockerfilePath: 'Dockerfile',
        target: null,
      },
      internalPort: 3000,
      publishedPort: null,
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('creates an Image service from the Image segment', async () => {
    api.createService.mockResolvedValue({ ok: true, data: SERVICE });
    const { user } = renderSheet();
    await user.type(screen.getByTestId('service-sheet-name'), 'web');
    await user.click(screen.getByRole('radio', { name: /alpha/ }));
    await user.click(screen.getByRole('radio', { name: 'Image' }));
    await user.type(screen.getByTestId('source-imageRef'), 'nginx:1.27');
    await user.click(screen.getByTestId('service-sheet-submit'));
    await waitFor(() => {
      expect(api.createService).toHaveBeenCalledTimes(1);
    });
    expect(api.createService.mock.calls[0]?.[1]).toMatchObject({ source: { kind: 'image', imageRef: 'nginx:1.27' } });
  });

  it.each([
    'file:///etc/passwd',
    'ext::sh -c id',
    'git://github.com/acme/web.git',
    'http://github.com/acme/web.git',
    'javascript:alert(1)',
    'https://user:pass@github.com/acme/web.git',
    '-oProxyCommand=id',
    'https://github.com/acme/../web.git',
  ])('rejects %s inline before any request (H2)', async (url) => {
    const { user } = renderSheet();
    await fillCreate(user, url);
    await user.click(screen.getByTestId('service-sheet-submit'));
    expect(screen.getByTestId('source-repositoryUrl')).toHaveAttribute('aria-invalid', 'true');
    expect(api.createService).not.toHaveBeenCalled();
  });

  it('states the v0.2 limit once, without coming-soon wording, and has no env or build-arg field (A4)', () => {
    renderSheet();
    expect(screen.getAllByText(V02_LIMIT_COPY)).toHaveLength(1);
    expect(document.body.textContent).not.toMatch(/coming soon/i);
    expect(screen.queryByLabelText(/environment variable|build arg/i)).not.toBeInTheDocument();
  });

  it('a double click sends one POST and the button is disabled while pending (H3)', async () => {
    const pending = deferred<{ ok: true; data: ServiceView }>();
    api.createService.mockReturnValue(pending.promise);
    const { user, onSaved } = renderSheet();
    await fillCreate(user);
    await user.dblClick(screen.getByTestId('service-sheet-submit'));
    expect(screen.getByTestId('service-sheet-submit')).toBeDisabled();
    pending.resolve({ ok: true, data: SERVICE });
    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledTimes(1);
    });
    expect(api.createService).toHaveBeenCalledTimes(1);
  });

  it('maps PORT_IN_USE to the published port with a hint (H3)', async () => {
    api.createService.mockResolvedValue({ ok: false, code: 'PORT_IN_USE', message: 'x', unauthorized: false });
    const { user, onOpenChange } = renderSheet();
    await fillCreate(user);
    await user.type(screen.getByTestId('service-sheet-published-port'), '8080');
    await user.click(screen.getByTestId('service-sheet-submit'));
    await waitFor(() => {
      expect(screen.getByText(PORT_IN_USE_COPY)).toBeInTheDocument();
    });
    expect(screen.getByTestId('service-sheet-published-port')).toHaveAttribute('aria-invalid', 'true');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('maps BUILDKIT unavailable to the source with a hint (H3)', async () => {
    api.createService.mockResolvedValue({ ok: false, code: 'SERVER_BUILDKIT_UNAVAILABLE', message: 'x', unauthorized: false });
    const { user } = renderSheet();
    await fillCreate(user);
    await user.click(screen.getByTestId('service-sheet-submit'));
    await waitFor(() => {
      expect(screen.getByTestId('source-error')).toHaveTextContent(BUILDKIT_UNAVAILABLE_COPY);
    });
  });

  it('shows the server validation error on its field when client and server disagree (A1)', async () => {
    api.createService.mockResolvedValue({
      ok: false,
      code: 'SERVICE_INPUT_INVALID',
      message: 'Git branch is not allowed on this server',
      reason: 'GIT_BRANCH_INVALID_CHARACTER',
      unauthorized: false,
    });
    const { user } = renderSheet();
    await fillCreate(user);
    await user.click(screen.getByTestId('service-sheet-submit'));
    await waitFor(() => {
      expect(screen.getByText('Git branch is not allowed on this server.')).toBeInTheDocument();
    });
    expect(screen.getByTestId('source-branch')).toHaveAttribute('aria-invalid', 'true');
  });

  it('other failures show fixed copy with the code', async () => {
    api.createService.mockResolvedValue({ ok: false, code: 'INTERNAL_ERROR', message: 'stack trace here', unauthorized: false });
    const { user } = renderSheet();
    await fillCreate(user);
    await user.click(screen.getByTestId('service-sheet-submit'));
    await waitFor(() => {
      expect(screen.getByTestId('service-sheet-error')).toHaveTextContent(SERVICE_SAVE_FAILED_COPY);
    });
    expect(document.body.textContent).not.toContain('stack trace here');
  });

  it('points to access settings instead of taking a credential before the service exists', () => {
    renderSheet();
    expect(screen.getByTestId('service-sheet-access-hint')).toBeInTheDocument();
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });
});

describe('ServiceSheet: edit (A5)', () => {
  it('fixes the server, shows access, and warns that a source change needs a redeploy', async () => {
    api.updateService.mockResolvedValue({
      ok: true,
      data: { service: { ...SERVICE, branch: 'release' }, requiresRedeploy: true, changedFields: ['source'] },
    });
    const { user, onSaved } = renderSheet({ service: SERVICE });
    expect(screen.getByTestId('service-sheet-server-fixed')).toHaveTextContent('alpha');
    expect(screen.queryAllByTestId('service-sheet-server')).toHaveLength(0);
    await waitFor(() => {
      expect(screen.getByTestId('source-credentials')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('service-sheet-redeploy')).not.toBeInTheDocument();

    await user.clear(screen.getByTestId('source-branch'));
    await user.type(screen.getByTestId('source-branch'), 'release');
    expect(screen.getByTestId('service-sheet-redeploy')).toHaveTextContent(REDEPLOY_NEEDED_COPY);

    await user.click(screen.getByTestId('service-sheet-submit'));
    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledWith({ ...SERVICE, branch: 'release' }, { requiresRedeploy: true });
    });
    expect(api.updateService).toHaveBeenCalledWith(PROJECT_ID, SERVICE.id, {
      source: {
        kind: 'git',
        repositoryUrl: 'https://github.com/acme/web.git',
        branch: 'release',
        buildContext: '.',
        dockerfilePath: 'Dockerfile',
        target: null,
      },
    });
  });

  it('a rename alone needs no redeploy notice', async () => {
    const { user } = renderSheet({ service: SERVICE });
    await user.clear(screen.getByTestId('service-sheet-name'));
    await user.type(screen.getByTestId('service-sheet-name'), 'api');
    expect(screen.queryByTestId('service-sheet-redeploy')).not.toBeInTheDocument();
  });

  it('saving without changes sends nothing and closes', async () => {
    const { user, onOpenChange } = renderSheet({ service: SERVICE });
    await user.click(screen.getByTestId('service-sheet-submit'));
    expect(api.updateService).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('a double click on save sends one PATCH (H3)', async () => {
    const pending = deferred<{ ok: true; data: { service: ServiceView; requiresRedeploy: boolean; changedFields: string[] } }>();
    api.updateService.mockReturnValue(pending.promise);
    const { user, onSaved } = renderSheet({ service: SERVICE });
    await user.clear(screen.getByTestId('service-sheet-internal-port'));
    await user.type(screen.getByTestId('service-sheet-internal-port'), '8080');
    await user.dblClick(screen.getByTestId('service-sheet-submit'));
    expect(screen.getByTestId('service-sheet-submit')).toBeDisabled();
    pending.resolve({ ok: true, data: { service: SERVICE, requiresRedeploy: true, changedFields: ['internalPort'] } });
    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledTimes(1);
    });
    expect(api.updateService).toHaveBeenCalledTimes(1);
    expect(api.updateService.mock.calls[0]?.[2]).toEqual({ internalPort: 8080 });
  });
});
