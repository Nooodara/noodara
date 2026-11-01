import { describe, expect, it, vi } from 'vitest';
import { renderUi, screen, userEvent, waitFor } from '@noodara/ui/testing';
import { EnvRow, OriginPill, SecretPicker, VariableValue } from './EnvRow';
import { NEXT_DEPLOY_COPY } from '../lib/env-form';
import type { VariableRowView } from '../lib/env-api';
import type { SecretRowView } from '../lib/secret-api';

const variable = (overrides: Partial<VariableRowView> = {}): VariableRowView => ({
  id: 'v1',
  scope: 'service',
  key: 'PORT',
  value: '3000',
  updatedAt: null,
  ...overrides,
});
const SECRETS: SecretRowView[] = [
  { id: 's1', scope: 'project', name: 'db_password', hint: '••••', version: 1, updatedAt: null },
  { id: 's2', scope: 'environment', name: 'api_token', hint: '••••', version: 1, updatedAt: null },
];

describe('EnvRow (24-02 A1, H1)', () => {
  it('renders the key in mono, the value as text and the origin pill', () => {
    renderUi(
      <ul>
        <EnvRow variable={variable()} secrets={[]} busy={false} onSave={() => Promise.resolve(null)} onDelete={() => undefined} />
      </ul>,
    );
    expect(screen.getByTestId('variable-key')).toHaveTextContent('PORT');
    expect(screen.getByTestId('variable-key').className).toContain('font-mono');
    expect(screen.getByTestId('variable-value')).toHaveTextContent('3000');
    expect(screen.getByTestId('origin-pill')).toHaveTextContent('Service');
  });

  it('renders a secret reference as a chip with the name', () => {
    renderUi(<VariableValue value="<secret:db_password>" />);
    expect(screen.getByTestId('secret-chip')).toHaveTextContent('db_password');
    expect(screen.queryByTestId('variable-value')).not.toBeInTheDocument();
  });

  it('renders script-like keys and values as text and falls back for unknown scopes', () => {
    const script = '<img src=x onerror=alert(1)>';
    renderUi(
      <ul>
        <EnvRow
          variable={variable({ key: script, value: script, scope: 'galaxy' })}
          secrets={[]}
          busy={false}
          onSave={() => Promise.resolve(null)}
          onDelete={() => undefined}
        />
      </ul>,
    );
    expect(screen.getByTestId('variable-key').textContent).toBe(script);
    expect(screen.getByTestId('variable-value').textContent).toBe(script);
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByTestId('origin-pill')).toHaveTextContent('Other');
  });

  it('edits inline with the shared validator, offers Use a secret and states the next deploy', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(() => Promise.resolve(null));
    renderUi(
      <ul>
        <EnvRow variable={variable()} secrets={SECRETS} busy={false} onSave={onSave} onDelete={() => undefined} />
      </ul>,
    );
    await user.click(screen.getByTestId('variable-edit'));
    expect(screen.getByText(NEXT_DEPLOY_COPY)).toBeInTheDocument();
    const input = screen.getByTestId('variable-edit-value');
    expect(input).toHaveValue('3000');

    await user.selectOptions(screen.getByTestId('variable-edit-picker'), 'api_token');
    expect(input).toHaveValue('<secret:api_token>');
    expect(screen.getByRole('option', { name: 'db_password (Project)' })).toBeInTheDocument();

    await user.clear(input);
    await user.type(input, '<secret:Bad Name>');
    await user.click(screen.getByTestId('variable-edit-save'));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeInTheDocument();

    await user.clear(input);
    await user.type(input, '8080');
    await user.click(screen.getByTestId('variable-edit-save'));
    expect(onSave).toHaveBeenCalledWith('8080');
    await waitFor(() => {
      expect(screen.queryByTestId('variable-edit-form')).not.toBeInTheDocument();
    });
  });

  it('keeps the editor open with the failure copy when save fails', async () => {
    const user = userEvent.setup();
    renderUi(
      <ul>
        <EnvRow variable={variable()} secrets={[]} busy={false} onSave={() => Promise.resolve('Nope.')} onDelete={() => undefined} />
      </ul>,
    );
    await user.click(screen.getByTestId('variable-edit'));
    await user.click(screen.getByTestId('variable-edit-save'));
    expect(await screen.findByText('Nope.')).toBeInTheDocument();
    await user.click(screen.getByTestId('variable-edit-cancel'));
    expect(screen.queryByTestId('variable-edit-form')).not.toBeInTheDocument();
  });

  it('disables the picker when no secrets are visible', () => {
    renderUi(
      <>
        <SecretPicker secrets={[]} onPick={() => undefined} />
        <OriginPill scope="project" />
      </>,
    );
    expect(screen.getByTestId('secret-picker')).toBeDisabled();
    expect(screen.getByLabelText('Use a secret')).toBeInTheDocument();
    expect(screen.getByTestId('origin-pill')).toHaveTextContent('Project');
  });
});
