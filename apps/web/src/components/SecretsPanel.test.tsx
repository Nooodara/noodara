import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderUi, screen, userEvent, waitFor, within } from '@noodara/ui/testing';
import { SECRET_IN_USE_COPY, SECRETS_EMPTY_COPY, SECRETS_LOAD_FAILED_COPY, SecretsPanel } from './SecretsPanel';
import type { EnvOwner } from '../lib/env-api';
import type { SecretRowView } from '../lib/secret-api';

const api = vi.hoisted(() => ({
  listSecrets: vi.fn(),
  createSecret: vi.fn(),
  replaceSecret: vi.fn(),
  deleteSecret: vi.fn(),
}));
vi.mock('../lib/secret-api', async (importOriginal) => {
  const actual: Record<string, unknown> = await importOriginal();
  return {
    ...actual,
    listSecrets: (...a: unknown[]) => api.listSecrets(...a) as unknown,
    createSecret: (...a: unknown[]) => api.createSecret(...a) as unknown,
    replaceSecret: (...a: unknown[]) => api.replaceSecret(...a) as unknown,
    deleteSecret: (...a: unknown[]) => api.deleteSecret(...a) as unknown,
  };
});
vi.mock('../lib/require-session', () => ({ requireSession: () => undefined }));

const CANARY = 'sk_live_CANARYsecret0123456789XYZ';
const OWNER: EnvOwner = { scope: 'project', projectId: 'p1' };
const NOW = new Date('2026-11-01T12:00:00.000Z');
const ok = (data: unknown) => Promise.resolve({ ok: true, data });
const fail = (code: string, extra: Record<string, unknown> = {}) =>
  Promise.resolve({ ok: false, code, message: 'raw server text', unauthorized: false, ...extra });
const secret = (id: string, name: string, overrides: Partial<SecretRowView> = {}): SecretRowView => ({
  id,
  scope: 'project',
  name,
  hint: '••••abcd',
  version: 1,
  updatedAt: '2026-11-01T11:00:00.000Z',
  ...overrides,
});

const consoleSpies: { mockRestore: () => void; mock: { calls: unknown[][] } }[] = [];
beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    consoleSpies.push(vi.spyOn(console, method).mockImplementation(() => undefined));
  }
});
afterEach(() => {
  for (const spy of consoleSpies.splice(0)) spy.mockRestore();
});

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

async function fillCreate(user: ReturnType<typeof userEvent.setup>, name: string, value: string) {
  await user.type(screen.getByTestId('secret-create-name'), name);
  await user.type(screen.getByTestId('secret-create-value'), value);
  await user.click(screen.getByTestId('secret-create-submit'));
}

describe('SecretsPanel (24-02 A2, H1)', () => {
  it('lists secrets with name, scope, hint and version, and has no reveal control', async () => {
    api.listSecrets.mockReturnValue(ok([secret('s1', 'db_password', { version: 2, scope: 'nebula' })]));
    renderUi(<SecretsPanel owner={OWNER} now={NOW} />);
    const row = await screen.findByTestId('secret-row-s1');
    expect(row).toHaveTextContent('db_password');
    expect(row).toHaveTextContent('••••abcd');
    expect(row).toHaveTextContent('v2');
    expect(within(row).getByTestId('secret-scope-pill')).toHaveTextContent('Other');
    expect(screen.queryByRole('button', { name: /reveal|show|view/i })).not.toBeInTheDocument();
    expect(api.listSecrets).toHaveBeenCalledWith(OWNER);
  });

  it('creates with a labelled masked value that is cleared on submit and never echoed', async () => {
    api.listSecrets.mockReturnValue(ok([]));
    api.createSecret.mockReturnValue(ok(secret('s2', 'api_token')));
    const onChanged = vi.fn();
    const user = userEvent.setup();
    renderUi(<SecretsPanel owner={OWNER} onChanged={onChanged} now={NOW} />);
    expect(await screen.findByText(SECRETS_EMPTY_COPY)).toBeInTheDocument();
    const input = screen.getByLabelText('Secret value');
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveAttribute('autocomplete', 'off');
    await fillCreate(user, 'api_token', CANARY);
    expect(api.createSecret).toHaveBeenCalledWith(OWNER, 'api_token', CANARY);
    expect(input).toHaveValue('');
    expect(await screen.findByTestId('secret-row-s2')).toBeInTheDocument();
    expect(screen.getByTestId('secret-create-name')).toHaveValue('');
    expect(onChanged).toHaveBeenCalledTimes(1);
    expectNoLeak();
  });

  it('clears the value even when create fails', async () => {
    api.listSecrets.mockReturnValue(ok([]));
    api.createSecret.mockReturnValue(fail('SECRET_NAME_DUPLICATE'));
    const user = userEvent.setup();
    renderUi(<SecretsPanel owner={OWNER} />);
    await screen.findByText(SECRETS_EMPTY_COPY);
    await fillCreate(user, 'api_token', CANARY);
    expect(await screen.findByText('This scope already has a secret with this name.')).toBeInTheDocument();
    expect(screen.getByTestId('secret-create-value')).toHaveValue('');
    expect(screen.queryByText('raw server text')).not.toBeInTheDocument();
    expectNoLeak();
  });

  it('validates the name locally and keeps nothing after unmount', async () => {
    api.listSecrets.mockReturnValue(ok([]));
    const user = userEvent.setup();
    const { unmount } = renderUi(<SecretsPanel owner={OWNER} />);
    await screen.findByText(SECRETS_EMPTY_COPY);
    await fillCreate(user, 'Bad-Name', CANARY);
    expect(api.createSecret).not.toHaveBeenCalled();
    expect(screen.getByTestId('secret-create-name')).toHaveAttribute('aria-invalid', 'true');
    unmount();
    expectNoLeak();
  });

  it('replace goes through the row confirmation', async () => {
    api.listSecrets.mockReturnValue(ok([secret('s1', 'db_password')]));
    api.replaceSecret.mockReturnValue(ok(secret('s1', 'db_password', { version: 2 })));
    const user = userEvent.setup();
    renderUi(<SecretsPanel owner={OWNER} now={NOW} />);
    await screen.findByTestId('secret-row-s1');
    await user.click(screen.getByTestId('secret-replace'));
    await user.type(screen.getByTestId('secret-replace-value'), CANARY);
    await user.click(screen.getByTestId('secret-replace-save'));
    await user.click(within(await screen.findByTestId('secret-replace-confirm')).getByRole('button', { name: 'Replace value' }));
    expect(api.replaceSecret).toHaveBeenCalledWith(OWNER, 's1', CANARY);
    await waitFor(() => {
      expect(screen.getByTestId('secret-version')).toHaveTextContent('v2');
    });
    expectNoLeak();
  });

  it('delete asks first and SECRET_IN_USE lists the referencing variables', async () => {
    api.listSecrets.mockReturnValue(ok([secret('s1', 'db_password')]));
    api.deleteSecret.mockReturnValueOnce(
      fail('SECRET_IN_USE', {
        usedBy: [
          { scope: 'service', key: 'DATABASE_PASSWORD' },
          { scope: 'environment', key: 'DB_PASS' },
        ],
      }),
    );
    api.deleteSecret.mockReturnValueOnce(ok(null));
    const user = userEvent.setup();
    renderUi(<SecretsPanel owner={OWNER} now={NOW} />);
    await screen.findByTestId('secret-row-s1');
    await user.click(screen.getByTestId('secret-delete'));
    expect(api.deleteSecret).not.toHaveBeenCalled();
    const dialog = await screen.findByTestId('secret-delete-confirm');
    await user.click(within(dialog).getByRole('button', { name: 'Delete secret' }));
    const inUse = await screen.findByTestId('secret-in-use');
    expect(inUse).toHaveTextContent(SECRET_IN_USE_COPY);
    expect(within(inUse).getAllByTestId('secret-in-use-item').map((item) => item.textContent)).toEqual([
      'DATABASE_PASSWORD (Service)',
      'DB_PASS (Environment)',
    ]);
    expect(screen.getByTestId('secret-row-s1')).toBeInTheDocument();

    await user.click(screen.getByTestId('secret-delete'));
    await user.click(within(await screen.findByTestId('secret-delete-confirm')).getByRole('button', { name: 'Delete secret' }));
    await waitFor(() => {
      expect(screen.queryByTestId('secret-row-s1')).not.toBeInTheDocument();
    });
    expect(screen.queryByTestId('secret-in-use')).not.toBeInTheDocument();
  });

  it('shows fixed copy when loading fails', async () => {
    api.listSecrets.mockReturnValue(fail('INTERNAL_ERROR'));
    renderUi(<SecretsPanel owner={OWNER} />);
    expect(await screen.findByText(SECRETS_LOAD_FAILED_COPY)).toBeInTheDocument();
  });
});
