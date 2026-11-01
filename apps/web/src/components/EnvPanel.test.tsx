import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderUi, screen, userEvent, waitFor, within } from '@noodara/ui/testing';
import { EnvPanel, VARIABLES_EMPTY_COPY, VARIABLES_LOAD_FAILED_COPY } from './EnvPanel';
import { NEXT_DEPLOY_COPY } from '../lib/env-form';
import type { EnvOwner, VariableRowView } from '../lib/env-api';

const api = vi.hoisted(() => ({
  listVariables: vi.fn(),
  createVariable: vi.fn(),
  updateVariable: vi.fn(),
  deleteVariable: vi.fn(),
  listVisibleSecrets: vi.fn(),
}));
vi.mock('../lib/env-api', async (importOriginal) => {
  const actual: Record<string, unknown> = await importOriginal();
  return {
    ...actual,
    listVariables: (...a: unknown[]) => api.listVariables(...a) as unknown,
    createVariable: (...a: unknown[]) => api.createVariable(...a) as unknown,
    updateVariable: (...a: unknown[]) => api.updateVariable(...a) as unknown,
    deleteVariable: (...a: unknown[]) => api.deleteVariable(...a) as unknown,
  };
});
vi.mock('../lib/secret-api', async (importOriginal) => {
  const actual: Record<string, unknown> = await importOriginal();
  return { ...actual, listVisibleSecrets: (...a: unknown[]) => api.listVisibleSecrets(...a) as unknown };
});
vi.mock('../lib/require-session', () => ({ requireSession: () => undefined }));

const ok = (data: unknown) => Promise.resolve({ ok: true, data });
const fail = (code: string, reason?: string) =>
  Promise.resolve({ ok: false, code, message: 'raw server text', unauthorized: false, ...(reason === undefined ? {} : { reason }) });

const OWNER: EnvOwner = { scope: 'environment', projectId: 'p1', environmentId: 'e1' };
const row = (id: string, key: string, value: string): VariableRowView => ({ id, scope: 'environment', key, value, updatedAt: null });
const SECRETS = [{ id: 's1', scope: 'project', name: 'db_password', hint: '••••', version: 1, updatedAt: null }];

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.listVisibleSecrets.mockReturnValue(ok(SECRETS));
});

describe('EnvPanel (24-02 A1)', () => {
  it('lists the scope variables and states that edits apply on the next deploy', async () => {
    api.listVariables.mockReturnValue(ok([row('v1', 'PORT', '3000'), row('v2', 'DB', '<secret:db_password>')]));
    renderUi(<EnvPanel owner={OWNER} />);
    expect(await screen.findByTestId('env-row-v1')).toHaveTextContent('PORT');
    expect(within(screen.getByTestId('env-row-v2')).getByTestId('secret-chip')).toHaveTextContent('db_password');
    expect(screen.getByTestId('env-next-deploy')).toHaveTextContent(NEXT_DEPLOY_COPY);
    expect(api.listVariables).toHaveBeenCalledWith(OWNER);
    expect(api.listVisibleSecrets).toHaveBeenCalledWith(OWNER);
  });

  it('adds a variable with a picked secret and announces the next deploy', async () => {
    api.listVariables.mockReturnValue(ok([]));
    api.createVariable.mockReturnValue(ok(row('v3', 'DATABASE_PASSWORD', '<secret:db_password>')));
    const onChanged = vi.fn();
    const user = userEvent.setup();
    renderUi(<EnvPanel owner={OWNER} onChanged={onChanged} />);
    expect(await screen.findByText(VARIABLES_EMPTY_COPY)).toBeInTheDocument();
    await user.type(screen.getByTestId('env-add-key'), 'DATABASE_PASSWORD');
    await waitFor(() => {
      expect(screen.getByTestId('env-add-picker')).not.toBeDisabled();
    });
    await user.selectOptions(screen.getByTestId('env-add-picker'), 'db_password');
    expect(screen.getByTestId('env-add-value')).toHaveValue('<secret:db_password>');
    await user.click(screen.getByTestId('env-add-submit'));
    expect(api.createVariable).toHaveBeenCalledWith(OWNER, 'DATABASE_PASSWORD', '<secret:db_password>');
    expect(await screen.findByTestId('env-row-v3')).toBeInTheDocument();
    expect(screen.getByTestId('env-announce')).toHaveTextContent(NEXT_DEPLOY_COPY);
    expect(screen.getByTestId('env-add-key')).toHaveValue('');
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('validates locally with the shared validators before calling the API', async () => {
    api.listVariables.mockReturnValue(ok([]));
    const user = userEvent.setup();
    renderUi(<EnvPanel owner={OWNER} />);
    await screen.findByText(VARIABLES_EMPTY_COPY);
    await user.type(screen.getByTestId('env-add-key'), '1bad');
    await user.click(screen.getByTestId('env-add-submit'));
    expect(screen.getByTestId('env-add-key')).toHaveAttribute('aria-invalid', 'true');
    expect(api.createVariable).not.toHaveBeenCalled();
  });

  it('maps API failures to fixed copy on the right field', async () => {
    api.listVariables.mockReturnValue(ok([]));
    api.createVariable.mockReturnValueOnce(fail('ENV_KEY_DUPLICATE')).mockReturnValueOnce(fail('INTERNAL_ERROR'));
    const user = userEvent.setup();
    renderUi(<EnvPanel owner={OWNER} />);
    await screen.findByText(VARIABLES_EMPTY_COPY);
    await user.type(screen.getByTestId('env-add-key'), 'PORT');
    await user.type(screen.getByTestId('env-add-value'), '1');
    await user.click(screen.getByTestId('env-add-submit'));
    expect(await screen.findByText('This scope already has a variable with this name.')).toBeInTheDocument();
    await user.click(screen.getByTestId('env-add-submit'));
    expect(await screen.findByTestId('env-error')).toBeInTheDocument();
    expect(screen.queryByText('raw server text')).not.toBeInTheDocument();
  });

  it('edits a row in place', async () => {
    api.listVariables.mockReturnValue(ok([row('v1', 'PORT', '3000')]));
    api.updateVariable.mockReturnValue(ok(row('v1', 'PORT', '8080')));
    const user = userEvent.setup();
    renderUi(<EnvPanel owner={OWNER} />);
    await screen.findByTestId('env-row-v1');
    await user.click(screen.getByTestId('variable-edit'));
    await user.clear(screen.getByTestId('variable-edit-value'));
    await user.type(screen.getByTestId('variable-edit-value'), '8080');
    await user.click(screen.getByTestId('variable-edit-save'));
    expect(api.updateVariable).toHaveBeenCalledWith(OWNER, 'v1', '8080');
    await waitFor(() => {
      expect(screen.getByTestId('env-row-v1')).toHaveTextContent('8080');
    });
  });

  it('asks before deleting', async () => {
    api.listVariables.mockReturnValue(ok([row('v1', 'PORT', '3000')]));
    api.deleteVariable.mockReturnValue(ok(null));
    const user = userEvent.setup();
    renderUi(<EnvPanel owner={OWNER} />);
    await screen.findByTestId('env-row-v1');
    await user.click(screen.getByTestId('variable-delete'));
    expect(api.deleteVariable).not.toHaveBeenCalled();
    const dialog = await screen.findByTestId('env-delete-confirm');
    expect(within(dialog).getByText('Delete PORT?')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Delete variable' }));
    expect(api.deleteVariable).toHaveBeenCalledWith(OWNER, 'v1');
    await waitFor(() => {
      expect(screen.queryByTestId('env-row-v1')).not.toBeInTheDocument();
    });
  });

  it('shows fixed copy when loading fails', async () => {
    api.listVariables.mockReturnValue(fail('INTERNAL_ERROR'));
    renderUi(<EnvPanel owner={OWNER} />);
    expect(await screen.findByText(VARIABLES_LOAD_FAILED_COPY)).toBeInTheDocument();
  });
});
