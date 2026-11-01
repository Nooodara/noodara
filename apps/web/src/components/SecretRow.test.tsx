import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderUi, screen, userEvent, waitFor, within } from '@noodara/ui/testing';
import { SecretRow } from './SecretRow';
import type { SecretRowView } from '../lib/secret-api';

const CANARY = 'sk_live_CANARYsecret0123456789XYZ';
const NOW = new Date('2026-11-01T12:00:00.000Z');
const SECRET: SecretRowView = {
  id: 's1',
  scope: 'environment',
  name: 'db_password',
  hint: '••••wxyz',
  version: 3,
  updatedAt: '2026-11-01T11:00:00.000Z',
};

const consoleSpies: { mockRestore: () => void; mock: { calls: unknown[][] } }[] = [];
beforeEach(() => {
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

function renderRow(onReplace: (value: string) => Promise<string | null> = () => Promise.resolve(null)) {
  return renderUi(
    <ul>
      <SecretRow secret={SECRET} busy={false} onReplace={onReplace} onDelete={() => undefined} now={NOW} />
    </ul>,
  );
}

describe('SecretRow (24-02 A2, H1)', () => {
  it('shows name, scope, hint, version and updatedAt and no reveal control', () => {
    renderRow();
    expect(screen.getByTestId('secret-name')).toHaveTextContent('db_password');
    expect(screen.getByTestId('secret-scope-pill')).toHaveTextContent('Environment');
    expect(screen.getByTestId('secret-hint')).toHaveTextContent('••••wxyz');
    expect(screen.getByTestId('secret-version')).toHaveTextContent('v3');
    expect(screen.getByTestId('secret-updated')).toHaveTextContent('Updated');
    expect(screen.queryByRole('button', { name: /reveal|show|view|copy/i })).not.toBeInTheDocument();
  });

  it('replace uses a labelled masked input and asks for confirmation; the value is gone after', async () => {
    const onReplace = vi.fn(() => Promise.resolve(null));
    const user = userEvent.setup();
    renderRow(onReplace);
    await user.click(screen.getByTestId('secret-replace'));
    const input = screen.getByLabelText('New value for db_password');
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveAttribute('autocomplete', 'off');
    expect(input).toHaveValue('');
    await user.type(input, CANARY);
    await user.click(screen.getByTestId('secret-replace-save'));
    expect(onReplace).not.toHaveBeenCalled();
    const dialog = await screen.findByTestId('secret-replace-confirm');
    await user.click(within(dialog).getByRole('button', { name: 'Replace value' }));
    expect(onReplace).toHaveBeenCalledWith(CANARY);
    await waitFor(() => {
      expect(screen.queryByTestId('secret-replace-form')).not.toBeInTheDocument();
    });
    expectNoLeak();
    await user.click(screen.getByTestId('secret-replace'));
    expect(screen.getByTestId('secret-replace-value')).toHaveValue('');
  });

  it('a failed replace clears the value and shows the copy', async () => {
    const user = userEvent.setup();
    renderRow(() => Promise.resolve('Fixed failure.'));
    await user.click(screen.getByTestId('secret-replace'));
    await user.type(screen.getByTestId('secret-replace-value'), CANARY);
    await user.click(screen.getByTestId('secret-replace-save'));
    await user.click(within(await screen.findByTestId('secret-replace-confirm')).getByRole('button', { name: 'Replace value' }));
    expect(await screen.findByText('Fixed failure.')).toBeInTheDocument();
    expect(screen.getByTestId('secret-replace-value')).toHaveValue('');
    expectNoLeak();
  });

  it('cancel and unmount drop the typed value', async () => {
    const user = userEvent.setup();
    const { unmount } = renderRow();
    await user.click(screen.getByTestId('secret-replace'));
    await user.type(screen.getByTestId('secret-replace-value'), CANARY);
    await user.click(screen.getByTestId('secret-replace-cancel'));
    expectNoLeak();
    await user.click(screen.getByTestId('secret-replace'));
    expect(screen.getByTestId('secret-replace-value')).toHaveValue('');
    await user.type(screen.getByTestId('secret-replace-value'), CANARY);
    unmount();
    expectNoLeak();
  });

  it('rejects an empty value without asking', async () => {
    const user = userEvent.setup();
    renderRow();
    await user.click(screen.getByTestId('secret-replace'));
    await user.click(screen.getByTestId('secret-replace-save'));
    expect(screen.getByText('Enter the secret value.')).toBeInTheDocument();
    expect(screen.queryByTestId('secret-replace-confirm')).not.toBeInTheDocument();
  });
});
