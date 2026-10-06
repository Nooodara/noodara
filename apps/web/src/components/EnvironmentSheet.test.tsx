import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderUi, screen, userEvent, waitFor } from '@noodara/ui/testing';
import {
  ENVIRONMENT_CREATE_FAILED_COPY,
  ENVIRONMENT_NAME_INVALID_COPY,
  ENVIRONMENT_NAME_TAKEN_COPY,
  EnvironmentSheet,
} from './EnvironmentSheet';
import { subscribeProjectsChanged } from './ProjectNav';

const deployApi = vi.hoisted(() => ({ createEnvironment: vi.fn() }));

vi.mock('../lib/deploy-api', () => ({
  createEnvironment: (projectId: string, body: unknown) => deployApi.createEnvironment(projectId, body) as unknown,
}));
vi.mock('../lib/require-session', () => ({ requireSession: () => undefined }));

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

function environment(name: string) {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    projectId: PROJECT_ID,
    name,
    kind: name,
    createdAt: '2026-10-06T00:00:00.000Z',
    updatedAt: '2026-10-06T00:00:00.000Z',
  };
}

function failure(code: string, message = 'raw server text: duplicate key value violates constraint') {
  return Promise.resolve({ ok: false, code, message, unauthorized: false });
}

function renderSheet(props: Partial<Parameters<typeof EnvironmentSheet>[0]> = {}) {
  const onOpenChange = vi.fn();
  const onCreated = vi.fn();
  renderUi(<EnvironmentSheet open onOpenChange={onOpenChange} projectId={PROJECT_ID} onCreated={onCreated} {...props} />);
  return { onOpenChange, onCreated, user: userEvent.setup() };
}

beforeEach(() => {
  deployApi.createEnvironment.mockReset();
});

describe('EnvironmentSheet (13-10 A1, H2)', () => {
  it('suggests production, staging and development and fills the name on tap', async () => {
    const { user } = renderSheet();
    for (const name of ['production', 'staging', 'development']) {
      expect(screen.getByTestId(`environment-suggestion-${name}`)).toBeInTheDocument();
    }
    await user.click(screen.getByTestId('environment-suggestion-staging'));
    expect(screen.getByTestId('environment-sheet-name')).toHaveValue('staging');
    expect(screen.getByTestId('environment-suggestion-staging')).toHaveAttribute('aria-pressed', 'true');
  });

  it('hides suggestions the project already uses', () => {
    renderSheet({ existingNames: ['production'] });
    expect(screen.queryByTestId('environment-suggestion-production')).not.toBeInTheDocument();
    expect(screen.getByTestId('environment-suggestion-staging')).toBeInTheDocument();
  });

  it('accepts any valid name, creates it once and refreshes the sidebar', async () => {
    deployApi.createEnvironment.mockReturnValue(Promise.resolve({ ok: true, data: environment('qa-eu') }));
    const changed = vi.fn();
    const unsubscribe = subscribeProjectsChanged(changed);
    const { user, onCreated, onOpenChange } = renderSheet();
    await user.type(screen.getByTestId('environment-sheet-name'), 'qa-eu');
    await user.click(screen.getByTestId('environment-sheet-submit'));
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
    expect(deployApi.createEnvironment).toHaveBeenCalledTimes(1);
    expect(deployApi.createEnvironment).toHaveBeenCalledWith(PROJECT_ID, { name: 'qa-eu' });
    expect(onCreated).toHaveBeenCalledWith(environment('qa-eu'));
    expect(changed).toHaveBeenCalled();
    unsubscribe();
  });

  it('rejects an invalid name in place without calling the API', async () => {
    const { user } = renderSheet();
    await user.type(screen.getByTestId('environment-sheet-name'), 'Prod Env');
    await user.click(screen.getByTestId('environment-sheet-submit'));
    expect(await screen.findByText(ENVIRONMENT_NAME_INVALID_COPY)).toBeInTheDocument();
    expect(deployApi.createEnvironment).not.toHaveBeenCalled();
  });

  it('maps a 409 ENVIRONMENT_NAME_TAKEN to the name field and keeps the input', async () => {
    deployApi.createEnvironment.mockReturnValue(failure('ENVIRONMENT_NAME_TAKEN'));
    const { user, onOpenChange } = renderSheet();
    await user.type(screen.getByTestId('environment-sheet-name'), 'staging');
    await user.click(screen.getByTestId('environment-sheet-submit'));
    expect(await screen.findByText(ENVIRONMENT_NAME_TAKEN_COPY)).toBeInTheDocument();
    expect(screen.getByTestId('environment-sheet-name')).toHaveValue('staging');
    expect(screen.getByTestId('environment-sheet-name')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByText(/raw server text/)).not.toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('shows the server-side validation error (422) in place, never the raw text', async () => {
    deployApi.createEnvironment.mockReturnValue(failure('VALIDATION_FAILED'));
    const { user } = renderSheet();
    await user.type(screen.getByTestId('environment-sheet-name'), 'preview');
    await user.click(screen.getByTestId('environment-sheet-submit'));
    expect(await screen.findByText(ENVIRONMENT_NAME_INVALID_COPY)).toBeInTheDocument();
    expect(screen.getByTestId('environment-sheet-name')).toHaveValue('preview');
    expect(screen.queryByText(/raw server text/)).not.toBeInTheDocument();
  });

  it('shows fixed copy and the code for any other failure, keeping the input', async () => {
    deployApi.createEnvironment.mockReturnValue(failure('INTERNAL_ERROR'));
    const { user } = renderSheet();
    await user.type(screen.getByTestId('environment-sheet-name'), 'preview');
    await user.click(screen.getByTestId('environment-sheet-submit'));
    const banner = await screen.findByTestId('environment-sheet-error');
    expect(banner).toHaveTextContent(ENVIRONMENT_CREATE_FAILED_COPY);
    expect(banner).toHaveTextContent('INTERNAL_ERROR');
    expect(banner).not.toHaveTextContent('raw server text');
    expect(screen.getByTestId('environment-sheet-name')).toHaveValue('preview');
  });
});
