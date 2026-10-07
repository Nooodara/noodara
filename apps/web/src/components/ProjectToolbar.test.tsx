import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderUi, screen, userEvent, waitFor, within } from '@noodara/ui/testing';
import { ShellContext, type ShellContextValue } from '../lib/shell-context';
import type { ProjectView } from '../lib/deploy-api';
import { subscribeProjectsChanged } from './ProjectNav';
import { PROJECT_NAME_TAKEN_COPY } from './ProjectSheet';
import {
  PROJECT_ARCHIVE_FAILED_COPY,
  PROJECT_DESCRIPTION_INVALID_COPY,
  PROJECT_NOT_ARCHIVED_COPY,
  PROJECT_UPDATE_FAILED_COPY,
  ProjectToolbar,
} from './ProjectToolbar';

const deployApi = vi.hoisted(() => ({
  updateProject: vi.fn(),
  archiveProject: vi.fn(),
  unarchiveProject: vi.fn(),
  deleteProject: vi.fn(),
}));

vi.mock('../lib/deploy-api', () => ({
  updateProject: (id: string, body: unknown) => deployApi.updateProject(id, body) as unknown,
  archiveProject: (id: string) => deployApi.archiveProject(id) as unknown,
  unarchiveProject: (id: string) => deployApi.unarchiveProject(id) as unknown,
  deleteProject: (id: string, confirmName: string) => deployApi.deleteProject(id, confirmName) as unknown,
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

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

function project(extra: Partial<ProjectView> = {}): ProjectView {
  return {
    id: PROJECT_ID,
    name: 'Billing',
    slug: 'billing',
    description: 'Invoices and payments',
    archivedAt: null,
    createdAt: '2026-10-06T00:00:00.000Z',
    updatedAt: '2026-10-06T00:00:00.000Z',
    ...extra,
  };
}

function failure(code: string, extra: Record<string, unknown> = {}) {
  return Promise.resolve({ ok: false, code, message: 'raw server text', unauthorized: false, ...extra });
}

function renderToolbar(value: ProjectView = project()) {
  const props = { onProjectChange: vi.fn(), onDeleted: vi.fn(), onNewEnvironment: vi.fn() };
  renderUi(
    <ShellContext.Provider value={SHELL_CONTEXT}>
      <ProjectToolbar project={value} {...props} />
    </ShellContext.Provider>,
  );
  return { ...props, user: userEvent.setup() };
}

beforeEach(() => {
  for (const fn of Object.values(deployApi)) fn.mockReset();
  vi.restoreAllMocks();
});

/** jsdom has no layout: report the toolbar's width as a real browser at `width` px would. */
function atWidth(width: number) {
  return vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ width, height: 52, top: 0, left: 0, right: width, bottom: 52, x: 0, y: 0, toJSON: () => ({}) }),
  );
}

const ARCHIVED_AT = '2026-10-06T01:00:00.000Z';
const LONG_NAME = 'checkoutsettlementreconciliation'.repeat(7).slice(0, 200);

async function menuItems(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId('project-actions-menu'));
  return screen.getAllByRole('menuitem').map((item) => item.textContent);
}

describe('ProjectToolbar (13-10 A2, H1, H2)', () => {
  it('shows the project name, New environment, Edit and Archive; no Delete while active', async () => {
    const { user, onNewEnvironment } = renderToolbar();
    expect(screen.getByRole('heading', { name: 'Billing' })).toBeInTheDocument();
    expect(screen.getByTestId('project-edit-button')).toBeInTheDocument();
    expect(screen.getByTestId('project-archive-button')).toHaveTextContent('Archive');
    expect(screen.queryByTestId('project-delete-button')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('project-new-environment-button'));
    expect(onNewEnvironment).toHaveBeenCalledTimes(1);
  });

  it('archives the project and refreshes the sidebar', async () => {
    const archived = project({ archivedAt: '2026-10-06T01:00:00.000Z' });
    deployApi.archiveProject.mockReturnValue(Promise.resolve({ ok: true, data: archived }));
    const changed = vi.fn();
    const unsubscribe = subscribeProjectsChanged(changed);
    const { user, onProjectChange } = renderToolbar();
    await user.click(screen.getByTestId('project-archive-button'));
    await waitFor(() => {
      expect(onProjectChange).toHaveBeenCalledWith(archived);
    });
    expect(changed).toHaveBeenCalled();
    unsubscribe();
  });

  it('shows fixed copy when archiving fails', async () => {
    deployApi.archiveProject.mockReturnValue(failure('INTERNAL_ERROR'));
    const { user } = renderToolbar();
    await user.click(screen.getByTestId('project-archive-button'));
    expect(await screen.findByTestId('project-action-error')).toHaveTextContent(PROJECT_ARCHIVE_FAILED_COPY);
    expect(screen.queryByText('raw server text')).not.toBeInTheDocument();
  });

  it('unarchives an archived project, which also offers Delete', async () => {
    const active = project();
    deployApi.unarchiveProject.mockReturnValue(Promise.resolve({ ok: true, data: active }));
    const { user, onProjectChange } = renderToolbar(project({ archivedAt: '2026-10-06T01:00:00.000Z' }));
    expect(screen.getByTestId('project-archived-note')).toBeInTheDocument();
    expect(screen.getByTestId('project-delete-button')).toBeInTheDocument();
    await user.click(screen.getByTestId('project-archive-button'));
    await waitFor(() => {
      expect(onProjectChange).toHaveBeenCalledWith(active);
    });
    expect(deployApi.unarchiveProject).toHaveBeenCalledWith(PROJECT_ID);
  });

  it('deletes an archived project only after typing its exact name', async () => {
    deployApi.deleteProject.mockReturnValue(Promise.resolve({ ok: true, data: { ok: true, projectId: PROJECT_ID } }));
    const changed = vi.fn();
    const unsubscribe = subscribeProjectsChanged(changed);
    const { user, onDeleted } = renderToolbar(project({ archivedAt: '2026-10-06T01:00:00.000Z' }));
    await user.click(screen.getByTestId('project-delete-button'));
    const dialog = await screen.findByTestId('project-delete-dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Delete project' });
    await user.type(within(dialog).getByRole('textbox'), 'billing');
    expect(confirm).toBeDisabled();
    await user.clear(within(dialog).getByRole('textbox'));
    await user.type(within(dialog).getByRole('textbox'), 'Billing');
    await user.click(confirm);
    await waitFor(() => {
      expect(onDeleted).toHaveBeenCalledTimes(1);
    });
    expect(deployApi.deleteProject).toHaveBeenCalledWith(PROJECT_ID, 'Billing');
    expect(changed).toHaveBeenCalled();
    unsubscribe();
  });

  it('treats a 404 on delete as already deleted', async () => {
    deployApi.deleteProject.mockReturnValue(failure('NOT_FOUND'));
    const { user, onDeleted } = renderToolbar(project({ archivedAt: '2026-10-06T01:00:00.000Z' }));
    await user.click(screen.getByTestId('project-delete-button'));
    const dialog = await screen.findByTestId('project-delete-dialog');
    await user.type(within(dialog).getByRole('textbox'), 'Billing');
    await user.click(within(dialog).getByRole('button', { name: 'Delete project' }));
    await waitFor(() => {
      expect(onDeleted).toHaveBeenCalledTimes(1);
    });
  });

  it('explains PROJECT_NOT_ARCHIVED in the dialog', async () => {
    deployApi.deleteProject.mockReturnValue(failure('PROJECT_NOT_ARCHIVED'));
    const { user, onDeleted } = renderToolbar(project({ archivedAt: '2026-10-06T01:00:00.000Z' }));
    await user.click(screen.getByTestId('project-delete-button'));
    const dialog = await screen.findByTestId('project-delete-dialog');
    await user.type(within(dialog).getByRole('textbox'), 'Billing');
    await user.click(within(dialog).getByRole('button', { name: 'Delete project' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(PROJECT_NOT_ARCHIVED_COPY);
    expect(onDeleted).not.toHaveBeenCalled();
  });

  describe('edit sheet', () => {
    async function openEdit() {
      const rendered = renderToolbar();
      await rendered.user.click(screen.getByTestId('project-edit-button'));
      await screen.findByTestId('project-edit-sheet');
      return rendered;
    }

    it('prefills and saves the project, refreshing the sidebar', async () => {
      const saved = project({ name: 'Billing v2' });
      deployApi.updateProject.mockReturnValue(Promise.resolve({ ok: true, data: saved }));
      const changed = vi.fn();
      const unsubscribe = subscribeProjectsChanged(changed);
      const { user, onProjectChange } = await openEdit();
      const name = screen.getByTestId('project-edit-name');
      expect(name).toHaveValue('Billing');
      expect(screen.getByTestId('project-edit-description')).toHaveValue('Invoices and payments');
      await user.clear(name);
      await user.type(name, 'Billing v2');
      await user.click(screen.getByTestId('project-edit-submit'));
      await waitFor(() => {
        expect(onProjectChange).toHaveBeenCalledWith(saved);
      });
      expect(deployApi.updateProject).toHaveBeenCalledWith(PROJECT_ID, { name: 'Billing v2', description: 'Invoices and payments' });
      expect(changed).toHaveBeenCalled();
      unsubscribe();
    });

    it('maps a 409 PROJECT_NAME_TAKEN to the name field and keeps the input', async () => {
      deployApi.updateProject.mockReturnValue(failure('PROJECT_NAME_TAKEN'));
      const { user } = await openEdit();
      const name = screen.getByTestId('project-edit-name');
      await user.clear(name);
      await user.type(name, 'Payments');
      await user.click(screen.getByTestId('project-edit-submit'));
      expect(await screen.findByText(PROJECT_NAME_TAKEN_COPY)).toBeInTheDocument();
      expect(name).toHaveValue('Payments');
      expect(screen.queryByText('raw server text')).not.toBeInTheDocument();
    });

    it('maps a 422 about the description to the description field', async () => {
      deployApi.updateProject.mockReturnValue(failure('VALIDATION_FAILED', { issues: [{ path: 'description', message: 'raw' }] }));
      const { user } = await openEdit();
      await user.type(screen.getByTestId('project-edit-description'), ' more');
      await user.click(screen.getByTestId('project-edit-submit'));
      expect(await screen.findByText(PROJECT_DESCRIPTION_INVALID_COPY)).toBeInTheDocument();
      expect(screen.getByTestId('project-edit-description')).toHaveValue('Invoices and payments more');
    });

    it('shows fixed copy with the code for other failures', async () => {
      deployApi.updateProject.mockReturnValue(failure('INTERNAL_ERROR'));
      const { user } = await openEdit();
      await user.click(screen.getByTestId('project-edit-submit'));
      const banner = await screen.findByTestId('project-edit-error');
      expect(banner).toHaveTextContent(PROJECT_UPDATE_FAILED_COPY);
      expect(banner).toHaveTextContent('INTERNAL_ERROR');
      expect(banner).not.toHaveTextContent('raw server text');
    });
  });
});

describe('ProjectToolbar at 375 px (14-19 A1)', () => {
  it('keeps one row: the title holds 12 characters and Edit/Archive sit in the menu', async () => {
    atWidth(375);
    const { user } = renderToolbar(project({ name: LONG_NAME }));

    const toolbar = screen.getByTestId('shell-toolbar');
    expect(toolbar).toHaveAttribute('data-layout', 'compact');
    expect(toolbar.className).toMatch(/\bflex-nowrap\b/);
    expect(screen.getByTestId('shell-toolbar-title').className).toMatch(/min-w-\[12ch\]/);
    expect(screen.getByRole('heading', { level: 1 })).toHaveAttribute('title', LONG_NAME);
    expect(screen.queryByTestId('project-edit-button')).toBeNull();
    expect(screen.queryByTestId('project-archive-button')).toBeNull();
    expect(screen.queryByTestId('project-delete-button')).toBeNull();
    expect(await menuItems(user)).toEqual(['Edit', 'Archive']);
  });

  it('lists Edit, Unarchive and Delete for an archived project, Delete last and destructive', async () => {
    atWidth(375);
    const { user } = renderToolbar(project({ archivedAt: ARCHIVED_AT }));

    expect(await menuItems(user)).toEqual(['Edit', 'Unarchive', 'Delete']);
  });

  it('runs every action from the menu', async () => {
    atWidth(375);
    const archived = project({ archivedAt: ARCHIVED_AT });
    deployApi.archiveProject.mockReturnValue(Promise.resolve({ ok: true, data: archived }));
    const { user, onProjectChange } = renderToolbar();

    await menuItems(user);
    await user.click(screen.getByRole('menuitem', { name: 'Archive' }));
    await waitFor(() => {
      expect(onProjectChange).toHaveBeenCalledWith(archived);
    });

    await menuItems(user);
    await user.click(screen.getByRole('menuitem', { name: 'Edit' }));
    expect(await screen.findByTestId('project-edit-sheet')).toBeInTheDocument();
  });

  it('opens the delete confirmation from the menu and returns focus to the trigger on Escape', async () => {
    atWidth(375);
    const { user } = renderToolbar(project({ archivedAt: ARCHIVED_AT }));

    await menuItems(user);
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(await screen.findByTestId('project-delete-dialog')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByTestId('project-delete-dialog')).toBeNull();
    });
    expect(screen.getByTestId('project-actions-menu')).toHaveFocus();
  });

  it('gives the menu a labelled, always-visible 44 px trigger and the back link a 44 px arrow', () => {
    atWidth(375);
    renderToolbar();

    const trigger = screen.getByRole('button', { name: 'Actions for Billing' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('data-hit-area', '44');
    expect(trigger.className).not.toMatch(/opacity-0/);
    expect(screen.getByRole('link', { name: 'Back to Projects' }).className).toMatch(/\bh-11\b.*\bw-11\b|\bw-11\b.*\bh-11\b/);
  });

  it('keeps New environment as the one primary action with a 44 px target and its full name', async () => {
    atWidth(375);
    const { user, onNewEnvironment } = renderToolbar();

    const create = screen.getByTestId('project-new-environment-button');
    expect(create).toHaveAccessibleName('New environment');
    expect(create).toHaveAttribute('data-hit-area', '44');
    await user.click(create);
    expect(onNewEnvironment).toHaveBeenCalledTimes(1);
  });
});

describe('ProjectToolbar at 1280 px (14-19 A1)', () => {
  it('keeps Edit and Archive inline with no overflow menu', () => {
    atWidth(1280);
    renderToolbar();

    expect(screen.getByTestId('shell-toolbar')).toHaveAttribute('data-layout', 'full');
    expect(screen.getByTestId('project-edit-button')).toBeInTheDocument();
    expect(screen.getByTestId('project-archive-button')).toBeInTheDocument();
    expect(screen.queryByTestId('project-actions-menu')).toBeNull();
    expect(screen.getByTestId('project-new-environment-button')).toHaveTextContent('New environment');
  });
});
