import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderUi, screen, userEvent, waitFor } from '@noodara/ui/testing';
import { ProjectSheet, PROJECT_CREATE_FAILED_COPY, PROJECT_NAME_TAKEN_COPY } from './ProjectSheet';
import { subscribeProjectsChanged } from './ProjectNav';

const createProject = vi.hoisted(() => vi.fn());

vi.mock('../lib/deploy-api', () => ({
  createProject: (body: unknown) => createProject(body) as unknown,
}));
vi.mock('../lib/require-session', () => ({ requireSession: () => undefined }));

const PROJECT = {
  id: 'p1',
  name: 'Shop API',
  slug: 'shop-api',
  description: null,
  archivedAt: null,
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

function renderSheet(onCreated = vi.fn(), onOpenChange = vi.fn()) {
  renderUi(<ProjectSheet open onOpenChange={onOpenChange} onCreated={onCreated} />);
  return { onCreated, onOpenChange, user: userEvent.setup() };
}

beforeEach(() => {
  createProject.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('ProjectSheet (13-09 A2)', () => {
  it('asks for a name and an optional description, and shows the slug derived from the name', async () => {
    const { user } = renderSheet();
    expect(screen.getByRole('textbox', { name: 'Name' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Description' })).toBeInTheDocument();
    expect(screen.getByTestId('project-sheet-slug')).toHaveTextContent('The slug is derived from the name.');

    await user.type(screen.getByTestId('project-sheet-name'), 'Shop API');
    expect(screen.getByTestId('project-sheet-slug')).toHaveTextContent('Slug shop-api');
  });

  it('creates the project with a trimmed description, notifies the sidebar and closes', async () => {
    createProject.mockResolvedValue({ ok: true, data: PROJECT });
    const changed = vi.fn();
    const off = subscribeProjectsChanged(changed);
    const { user, onCreated, onOpenChange } = renderSheet();

    await user.type(screen.getByTestId('project-sheet-name'), '  Shop API ');
    await user.type(screen.getByTestId('project-sheet-description'), '  storefront  ');
    await user.click(screen.getByTestId('project-sheet-submit'));

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith(PROJECT);
    });
    expect(createProject).toHaveBeenCalledWith({ name: 'Shop API', description: 'storefront' });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    off();
  });

  it('sends a null description when it is left empty', async () => {
    createProject.mockResolvedValue({ ok: true, data: PROJECT });
    const { user } = renderSheet();
    await user.type(screen.getByTestId('project-sheet-name'), 'Shop API{Enter}');
    await waitFor(() => {
      expect(createProject).toHaveBeenCalledWith({ name: 'Shop API', description: null });
    });
  });

  it('rejects an empty name in place without calling the API', async () => {
    const { user } = renderSheet();
    await user.click(screen.getByTestId('project-sheet-submit'));
    expect(createProject).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('ProjectSheet hardening (13-09 H1)', () => {
  it('sends one POST for a double click and disables submit while pending', async () => {
    const pending = deferred<unknown>();
    createProject.mockReturnValue(pending.promise);
    const { user } = renderSheet();
    await user.type(screen.getByTestId('project-sheet-name'), 'Shop API');

    const submit = screen.getByTestId('project-sheet-submit');
    await user.dblClick(submit);
    expect(createProject).toHaveBeenCalledTimes(1);
    expect(submit).toBeDisabled();

    pending.resolve({ ok: true, data: PROJECT });
    await waitFor(() => {
      expect(submit).not.toBeDisabled();
    });
    expect(createProject).toHaveBeenCalledTimes(1);
  });

  it('shows a 409 duplicate name on the name field and keeps the sheet open', async () => {
    createProject.mockResolvedValue({
      ok: false,
      code: 'PROJECT_NAME_TAKEN',
      message: 'raw server text',
      unauthorized: false,
    });
    const { user, onOpenChange } = renderSheet();
    await user.type(screen.getByTestId('project-sheet-name'), 'Shop API');
    await user.click(screen.getByTestId('project-sheet-submit'));

    expect(await screen.findByText(PROJECT_NAME_TAKEN_COPY)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByText('raw server text')).not.toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('shows fixed copy and the error code for any other failure, never the server text', async () => {
    createProject.mockResolvedValue({ ok: false, code: 'NETWORK_ERROR', message: '<b>raw</b>', unauthorized: false });
    const { user } = renderSheet();
    await user.type(screen.getByTestId('project-sheet-name'), 'Shop API');
    await user.click(screen.getByTestId('project-sheet-submit'));

    const banner = await screen.findByTestId('project-sheet-error');
    expect(banner).toHaveTextContent(PROJECT_CREATE_FAILED_COPY);
    expect(banner).toHaveTextContent('NETWORK_ERROR');
    expect(banner).not.toHaveTextContent('raw');
  });

  it('keeps a hostile name as typed text and derives a safe slug from it', async () => {
    const { user } = renderSheet();
    await user.type(screen.getByTestId('project-sheet-name'), '<img src=x onerror=alert(1)>');
    expect(screen.getByTestId('project-sheet').querySelector('img')).toBeNull();
    expect(screen.getByTestId('project-sheet-slug')).toHaveTextContent('Slug img-src-x-onerror-alert-1');
  });
});
