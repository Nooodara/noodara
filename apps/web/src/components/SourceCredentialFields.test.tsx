import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderUi, screen, userEvent, waitFor } from '@noodara/ui/testing';
import {
  CREDENTIAL_REJECTED_COPY,
  CREDENTIAL_SAVE_FAILED_COPY,
  DEPLOY_KEY_HELP,
  SourceCredentialFields,
} from './SourceCredentialFields';

const api = vi.hoisted(() => ({
  getServiceCredentials: vi.fn(),
  setRepositoryCredential: vi.fn(),
  setRegistryCredential: vi.fn(),
  removeServiceCredential: vi.fn(),
}));

vi.mock('../lib/deploy-api', () => ({
  getServiceCredentials: (...args: unknown[]) => api.getServiceCredentials(...args) as unknown,
  setRepositoryCredential: (...args: unknown[]) => api.setRepositoryCredential(...args) as unknown,
  setRegistryCredential: (...args: unknown[]) => api.setRegistryCredential(...args) as unknown,
  removeServiceCredential: (...args: unknown[]) => api.removeServiceCredential(...args) as unknown,
}));
vi.mock('../lib/require-session', () => ({ requireSession: () => undefined }));

const CANARY = 'ghp_CANARYsecret0123456789abcdefXYZ';
const PROJECT_ID = 'p1';
const HTTPS_SERVICE = { id: 'svc1', sourceType: 'git' as const, repositoryUrl: 'https://github.com/acme/web.git' };
const SSH_SERVICE = { id: 'svc1', sourceType: 'git' as const, repositoryUrl: 'git@github.com:acme/web.git' };
const IMAGE_SERVICE = { id: 'svc1', sourceType: 'image' as const, repositoryUrl: null };
const NONE = { repository: null, registry: null };
const TOKEN_SET = { repository: { type: 'git_https_token', publicKey: null }, registry: null };
const PUBLIC_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPublicHalfOnly noodara';

function ok<T>(data: T) {
  return Promise.resolve({ ok: true, data });
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface ConsoleSpy {
  mockRestore: () => void;
  mock: { calls: unknown[][] };
}

const consoleSpies: ConsoleSpy[] = [];

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    consoleSpies.push(vi.spyOn(console, method).mockImplementation(() => undefined));
  }
});

afterEach(() => {
  for (const spy of consoleSpies.splice(0)) spy.mockRestore();
  vi.clearAllMocks();
});

/** The canary must not be anywhere a user, a log or another script could read it. */
function expectNoLeak(): void {
  expect(document.body.innerHTML).not.toContain(CANARY);
  for (const input of document.querySelectorAll('input')) expect(input.value).not.toContain(CANARY);
  expect(window.location.href).not.toContain(CANARY);
  for (const store of [window.localStorage, window.sessionStorage]) {
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index) ?? '';
      expect(`${key}=${store.getItem(key) ?? ''}`).not.toContain(CANARY);
    }
  }
  for (const spy of consoleSpies) expect(JSON.stringify(spy.mock.calls)).not.toContain(CANARY);
}

async function openTokenEditor() {
  const user = userEvent.setup();
  renderUi(<SourceCredentialFields projectId={PROJECT_ID} service={HTTPS_SERVICE} />);
  await waitFor(() => {
    expect(screen.getByTestId('credential-status')).toHaveTextContent('Not configured');
  });
  await user.click(screen.getByTestId('credential-replace'));
  return user;
}

describe('SourceCredentialFields: write-only token (13-11 A3, H1)', () => {
  it('uses a password input with autocomplete off and never a pre-filled value', async () => {
    api.getServiceCredentials.mockReturnValue(ok(NONE));
    await openTokenEditor();
    const input = screen.getByTestId('credential-secret');
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveAttribute('autocomplete', 'off');
    expect(input).toHaveValue('');
    expect(screen.getByTestId('credential-save')).toBeDisabled();
  });

  it('after save shows only Configured with replace and remove; the value is gone everywhere', async () => {
    api.getServiceCredentials.mockReturnValue(ok(NONE));
    api.setRepositoryCredential.mockReturnValue(ok(TOKEN_SET));
    const user = await openTokenEditor();

    await user.type(screen.getByTestId('credential-secret'), CANARY);
    await user.click(screen.getByTestId('credential-save'));

    await waitFor(() => {
      expect(screen.getByTestId('credential-status')).toHaveTextContent('Configured');
    });
    expect(api.setRepositoryCredential).toHaveBeenCalledTimes(1);
    expect(api.setRepositoryCredential).toHaveBeenCalledWith(PROJECT_ID, 'svc1', { kind: 'https_token', token: CANARY });
    expect(screen.queryByTestId('credential-secret')).not.toBeInTheDocument();
    expect(screen.getByTestId('credential-replace')).toHaveTextContent('Replace');
    expect(screen.getByTestId('credential-remove')).toBeInTheDocument();
    expectNoLeak();

    // Replacing starts from an empty input: no form default keeps the old value.
    await user.click(screen.getByTestId('credential-replace'));
    expect(screen.getByTestId('credential-secret')).toHaveValue('');
  });

  it('cancel drops the typed value; reopening starts empty', async () => {
    api.getServiceCredentials.mockReturnValue(ok(NONE));
    const user = await openTokenEditor();
    await user.type(screen.getByTestId('credential-secret'), CANARY);
    await user.click(screen.getByTestId('credential-cancel'));

    expect(screen.queryByTestId('credential-secret')).not.toBeInTheDocument();
    expectNoLeak();
    await user.click(screen.getByTestId('credential-replace'));
    expect(screen.getByTestId('credential-secret')).toHaveValue('');
    expect(api.setRepositoryCredential).not.toHaveBeenCalled();
  });

  it('unmounting (sheet closed) leaves nothing behind', async () => {
    api.getServiceCredentials.mockReturnValue(ok(NONE));
    const user = userEvent.setup();
    const { unmount } = renderUi(<SourceCredentialFields projectId={PROJECT_ID} service={HTTPS_SERVICE} />);
    await waitFor(() => {
      expect(screen.getByTestId('credential-replace')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('credential-replace'));
    await user.type(screen.getByTestId('credential-secret'), CANARY);
    unmount();
    expectNoLeak();
  });

  it('a failed save shows fixed copy, never the server text, and clears the input', async () => {
    api.getServiceCredentials.mockReturnValue(ok(NONE));
    api.setRepositoryCredential.mockResolvedValue({
      ok: false,
      code: 'INTERNAL_ERROR',
      message: `bad token ${CANARY}`,
      unauthorized: false,
    });
    const user = await openTokenEditor();
    await user.type(screen.getByTestId('credential-secret'), CANARY);
    await user.click(screen.getByTestId('credential-save'));

    await waitFor(() => {
      expect(screen.getByTestId('credential-error')).toHaveTextContent(CREDENTIAL_SAVE_FAILED_COPY);
    });
    expect(screen.getByTestId('credential-secret')).toHaveValue('');
    expectNoLeak();
  });

  it('a 422 credential rejection shows the rejected copy', async () => {
    api.getServiceCredentials.mockReturnValue(ok(NONE));
    api.setRepositoryCredential.mockResolvedValue({
      ok: false,
      code: 'SERVICE_CREDENTIAL_INVALID',
      message: CANARY,
      reason: 'TOKEN_TOO_LONG',
      unauthorized: false,
    });
    const user = await openTokenEditor();
    await user.type(screen.getByTestId('credential-secret'), CANARY);
    await user.click(screen.getByTestId('credential-save'));
    await waitFor(() => {
      expect(screen.getByTestId('credential-error')).toHaveTextContent(CREDENTIAL_REJECTED_COPY);
    });
    expectNoLeak();
  });

  it('a double click sends one request while the save is pending', async () => {
    api.getServiceCredentials.mockReturnValue(ok(NONE));
    const pending = deferred<{ ok: true; data: typeof TOKEN_SET }>();
    api.setRepositoryCredential.mockReturnValue(pending.promise);
    const user = await openTokenEditor();
    await user.type(screen.getByTestId('credential-secret'), CANARY);
    await user.dblClick(screen.getByTestId('credential-save'));
    expect(screen.getByTestId('credential-save')).toBeDisabled();
    pending.resolve({ ok: true, data: TOKEN_SET });
    await waitFor(() => {
      expect(screen.getByTestId('credential-status')).toHaveTextContent('Configured');
    });
    expect(api.setRepositoryCredential).toHaveBeenCalledTimes(1);
  });

  it('remove returns to Not configured', async () => {
    api.getServiceCredentials.mockReturnValue(ok(TOKEN_SET));
    api.removeServiceCredential.mockReturnValue(ok(NONE));
    const user = userEvent.setup();
    renderUi(<SourceCredentialFields projectId={PROJECT_ID} service={HTTPS_SERVICE} />);
    await waitFor(() => {
      expect(screen.getByTestId('credential-status')).toHaveTextContent('Configured');
    });
    await user.click(screen.getByTestId('credential-remove'));
    await waitFor(() => {
      expect(screen.getByTestId('credential-status')).toHaveTextContent('Not configured');
    });
    expect(api.removeServiceCredential).toHaveBeenCalledWith(PROJECT_ID, 'svc1', 'repository');
    expect(screen.queryByTestId('credential-remove')).not.toBeInTheDocument();
  });
});

describe('SourceCredentialFields: SSH deploy key (H2)', () => {
  it('generates a key server-side and shows only the public half with a copy action', async () => {
    api.getServiceCredentials.mockReturnValue(ok(NONE));
    api.setRepositoryCredential.mockReturnValue(ok({ repository: { type: 'git_deploy_key', publicKey: PUBLIC_KEY }, registry: null }));
    const user = userEvent.setup();
    renderUi(<SourceCredentialFields projectId={PROJECT_ID} service={SSH_SERVICE} />);
    await waitFor(() => {
      expect(screen.getByTestId('credential-replace')).toHaveTextContent('Generate key');
    });
    expect(screen.queryByTestId('credential-secret')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('credential-replace'));
    await waitFor(() => {
      expect(screen.getByTestId('deploy-key-public')).toHaveTextContent(PUBLIC_KEY);
    });
    expect(api.setRepositoryCredential).toHaveBeenCalledWith(PROJECT_ID, 'svc1', { kind: 'deploy_key' });
    expect(screen.getByRole('button', { name: 'Copy public key' })).toBeInTheDocument();
    expect(screen.getByText(DEPLOY_KEY_HELP)).toBeInTheDocument();
    expect(document.body.innerHTML).not.toMatch(/PRIVATE KEY/);
    expect(screen.queryByTestId('credential-secret')).not.toBeInTheDocument();
    expect(screen.getByTestId('credential-replace')).toHaveTextContent('Replace key');
  });
});

describe('SourceCredentialFields: registry password (A3, H1)', () => {
  it('sends host, username and password once, then forgets all three', async () => {
    api.getServiceCredentials.mockReturnValue(ok(NONE));
    api.setRegistryCredential.mockReturnValue(ok({ repository: null, registry: { type: 'registry_password', publicKey: null } }));
    const user = userEvent.setup();
    renderUi(<SourceCredentialFields projectId={PROJECT_ID} service={IMAGE_SERVICE} />);
    await waitFor(() => {
      expect(screen.getByTestId('credential-replace')).toHaveTextContent('Add');
    });
    expect(screen.getByText('Registry password')).toBeInTheDocument();
    await user.click(screen.getByTestId('credential-replace'));
    expect(screen.getByTestId('credential-secret')).toHaveAttribute('type', 'password');
    expect(screen.getByTestId('credential-secret')).toHaveAttribute('autocomplete', 'off');

    await user.type(screen.getByTestId('credential-registry-host'), 'ghcr.io');
    await user.type(screen.getByTestId('credential-registry-username'), 'acme');
    await user.type(screen.getByTestId('credential-secret'), CANARY);
    await user.click(screen.getByTestId('credential-save'));

    await waitFor(() => {
      expect(screen.getByTestId('credential-status')).toHaveTextContent('Configured');
    });
    expect(api.setRegistryCredential).toHaveBeenCalledWith(PROJECT_ID, 'svc1', { host: 'ghcr.io', username: 'acme', password: CANARY });
    expectNoLeak();
    await user.click(screen.getByTestId('credential-replace'));
    expect(screen.getByTestId('credential-registry-host')).toHaveValue('');
    expect(screen.getByTestId('credential-secret')).toHaveValue('');
  });

  it('rejects a bad registry host inline without sending', async () => {
    api.getServiceCredentials.mockReturnValue(ok(NONE));
    const user = userEvent.setup();
    renderUi(<SourceCredentialFields projectId={PROJECT_ID} service={IMAGE_SERVICE} />);
    await waitFor(() => {
      expect(screen.getByTestId('credential-replace')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('credential-replace'));
    await user.type(screen.getByTestId('credential-registry-host'), 'https://ghcr.io/x');
    await user.type(screen.getByTestId('credential-registry-username'), 'acme');
    await user.type(screen.getByTestId('credential-secret'), CANARY);
    await user.click(screen.getByTestId('credential-save'));
    expect(screen.getByText('Use host or host:port, without scheme or path.')).toBeInTheDocument();
    expect(api.setRegistryCredential).not.toHaveBeenCalled();
  });
});
