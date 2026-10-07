'use client';

// 13-10: the project view's toolbar and its project-level actions. "New environment" is the one
// primary action; Edit and Archive/Unarchive are ghost buttons; Delete appears only once the
// project is archived (the API rejects deleting an active project) and goes through
// ConfirmByNameDialog. Every successful mutation calls notifyProjectsChanged() so the sidebar
// refreshes. Failures show fixed copy, never the server's text.
//
// 14-19: in the compact toolbar (375 px) Edit, Archive/Unarchive and Delete move into a RowMenu and
// New environment keeps a 44 px target with a short label, so the title keeps 12 characters.
import { useEffect, useId, useRef, useState, type SyntheticEvent } from 'react';
import { MAX_PROJECT_DESCRIPTION_LENGTH, MAX_PROJECT_NAME_LENGTH, validateProjectName } from '@noodara/domain';
import { Banner, Button, Field, Input, RowMenu, Sheet, Textarea, type RowMenuItem } from '@noodara/ui';
import {
  archiveProject,
  deleteProject,
  unarchiveProject,
  updateProject,
  type DeployApiResult,
  type ProjectView,
} from '../lib/deploy-api';
import { requireSession } from '../lib/require-session';
import { ConfirmByNameDialog, deleteOutcome } from './ConfirmByNameDialog';
import { notifyProjectsChanged, PROJECTS_HREF } from './ProjectNav';
import { PROJECT_NAME_INVALID_COPY, PROJECT_NAME_TAKEN_COPY } from './ProjectSheet';
import { Toolbar, type ToolbarLayout } from './Toolbar';

export interface ProjectToolbarProps {
  readonly project: ProjectView;
  readonly onProjectChange: (project: ProjectView) => void;
  /** The project is gone (deleted here, or already deleted elsewhere). */
  readonly onDeleted: () => void;
  readonly onNewEnvironment: () => void;
}

export const PROJECT_DESCRIPTION_INVALID_COPY = `Use up to ${String(MAX_PROJECT_DESCRIPTION_LENGTH)} characters, without control characters.`;
export const PROJECT_UPDATE_FAILED_COPY = "Couldn't save the project. Check your connection and try again.";
export const PROJECT_ARCHIVE_FAILED_COPY = "Couldn't archive the project. Check your connection and try again.";
export const PROJECT_UNARCHIVE_FAILED_COPY = "Couldn't unarchive the project. Check your connection and try again.";
export const PROJECT_NOT_ARCHIVED_COPY = 'Archive the project before deleting it.';
const MENU_TEST_ID = 'project-actions-menu';

export const PROJECT_ARCHIVED_NOTE = 'This project is archived. New deploys are rejected until you unarchive it.';

export function ProjectToolbar({ project, onProjectChange, onDeleted, onNewEnvironment }: ProjectToolbarProps) {
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);
  const inFlight = useRef(false);
  const archived = project.archivedAt !== null;

  async function toggleArchive(): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setArchiving(true);
    setActionError(null);
    const result = archived ? await unarchiveProject(project.id) : await archiveProject(project.id);
    inFlight.current = false;
    setArchiving(false);
    if (result.ok) {
      onProjectChange(result.data);
      notifyProjectsChanged();
      return;
    }
    if (result.unauthorized) {
      void requireSession();
      return;
    }
    if (result.code === 'NOT_FOUND') {
      notifyProjectsChanged();
      onDeleted();
      return;
    }
    setActionError(archived ? PROJECT_UNARCHIVE_FAILED_COPY : PROJECT_ARCHIVE_FAILED_COPY);
  }

  function openEdit(): void {
    setEditOpen(true);
  }

  function openDelete(): void {
    setDeleteOpen(true);
  }

  const menuItems: RowMenuItem[] = [
    { id: 'edit', label: 'Edit', onSelect: openEdit },
    { id: 'archive', label: archived ? 'Unarchive' : 'Archive', onSelect: () => void toggleArchive() },
    ...(archived ? [{ id: 'delete', label: 'Delete', destructive: true, onSelect: openDelete }] : []),
  ];

  return (
    <div className="flex flex-col">
      <Toolbar
        title={project.name}
        backLink={{ href: PROJECTS_HREF, label: '← Projects' }}
        secondaryActions={(layout: ToolbarLayout) =>
          layout === 'compact' ? (
            <RowMenu triggerLabel={`Actions for ${project.name}`} data-testid={MENU_TEST_ID} items={menuItems} reveal="always" />
          ) : (
            <div className="flex items-center gap-1">
              <Button type="button" variant="ghost" data-testid="project-edit-button" onClick={openEdit}>
                Edit
              </Button>
              <Button
                type="button"
                variant="ghost"
                data-testid="project-archive-button"
                loading={archiving}
                disabled={archiving}
                onClick={() => void toggleArchive()}
              >
                {archived ? 'Unarchive' : 'Archive'}
              </Button>
              {archived ? (
                <Button type="button" variant="destructive" data-testid="project-delete-button" onClick={openDelete}>
                  Delete
                </Button>
              ) : null}
            </div>
          )
        }
        primaryAction={(layout: ToolbarLayout) => (
          <Button
            type="button"
            variant="primary"
            data-testid="project-new-environment-button"
            hitArea={layout === 'compact'}
            aria-label={layout === 'compact' ? 'New environment' : undefined}
            onClick={onNewEnvironment}
          >
            {layout === 'compact' ? 'New' : 'New environment'}
          </Button>
        )}
      />
      {archived ? (
        <p className="px-4 pt-2 text-caption text-ink-secondary" data-testid="project-archived-note">
          {PROJECT_ARCHIVED_NOTE}
        </p>
      ) : null}
      {actionError === null ? null : (
        <p role="alert" className="px-4 pt-2 text-caption text-status-error" data-testid="project-action-error">
          {actionError}
        </p>
      )}
      <EditProjectSheet open={editOpen} onOpenChange={setEditOpen} project={project} onSaved={onProjectChange} onGone={onDeleted} />
      <ConfirmByNameDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete ${project.name}?`}
        body="This permanently deletes the project and its environments. Type the project name to confirm."
        confirmLabel="Delete project"
        requiredName={project.name}
        data-testid="project-delete-dialog"
        returnFocusTo={() => document.querySelector<HTMLElement>(`[data-testid="${MENU_TEST_ID}"]`)}
        onConfirm={async (typed) => {
          const outcome = deleteOutcome(await deleteProject(project.id, typed), { PROJECT_NOT_ARCHIVED: PROJECT_NOT_ARCHIVED_COPY });
          if (outcome.ok) {
            notifyProjectsChanged();
            onDeleted();
          }
          return outcome;
        }}
      />
    </div>
  );
}

interface EditProjectSheetProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly project: ProjectView;
  readonly onSaved: (project: ProjectView) => void;
  readonly onGone: () => void;
}

interface FieldErrors {
  readonly name?: string | undefined;
  readonly description?: string | undefined;
}

/** Field-level copy for a failed update; `null` when the failure is not about a field. */
export function projectFieldErrors(result: DeployApiResult<unknown>): FieldErrors | null {
  if (result.ok) return null;
  if (result.code === 'PROJECT_NAME_TAKEN') return { name: PROJECT_NAME_TAKEN_COPY };
  if (result.code === 'VALIDATION_FAILED') {
    const aboutDescription = result.issues?.some((issue) => issue.path.includes('description')) === true;
    return aboutDescription ? { description: PROJECT_DESCRIPTION_INVALID_COPY } : { name: PROJECT_NAME_INVALID_COPY };
  }
  return null;
}

function EditProjectSheet({ open, onOpenChange, project, onSaved, onGone }: EditProjectSheetProps) {
  const formId = useId();
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? '');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<{ readonly code: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);

  // Reset from the project only when the sheet opens, so a failed save keeps what was typed.
  useEffect(() => {
    if (open) {
      setName(project.name);
      setDescription(project.description ?? '');
      setErrors({});
      setFailure(null);
    }
  }, [open]);

  async function submit(): Promise<void> {
    if (inFlight.current) return;
    const checked = validateProjectName(name);
    if (!checked.ok) {
      setErrors({ name: PROJECT_NAME_INVALID_COPY });
      return;
    }
    inFlight.current = true;
    setSubmitting(true);
    setErrors({});
    setFailure(null);
    const trimmed = description.trim();
    const result = await updateProject(project.id, { name: checked.value, description: trimmed === '' ? null : trimmed });
    inFlight.current = false;
    setSubmitting(false);

    if (result.ok) {
      notifyProjectsChanged();
      onSaved(result.data);
      onOpenChange(false);
      return;
    }
    if (result.unauthorized) {
      void requireSession();
      return;
    }
    if (result.code === 'NOT_FOUND') {
      onOpenChange(false);
      notifyProjectsChanged();
      onGone();
      return;
    }
    const fieldErrors = projectFieldErrors(result);
    if (fieldErrors !== null) {
      setErrors(fieldErrors);
      return;
    }
    setFailure({ code: result.code });
  }

  function onSubmit(event: SyntheticEvent): void {
    event.preventDefault();
    void submit();
  }

  const footer = (
    <>
      <Button
        type="button"
        variant="ghost"
        disabled={submitting}
        onClick={() => {
          onOpenChange(false);
        }}
      >
        Cancel
      </Button>
      <Button type="submit" form={formId} variant="primary" data-testid="project-edit-submit" loading={submitting} disabled={submitting}>
        Save
      </Button>
    </>
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Edit project" footer={footer} data-testid="project-edit-sheet">
      <form id={formId} onSubmit={onSubmit} className="flex flex-col gap-6" noValidate>
        {failure === null ? null : <Banner message={PROJECT_UPDATE_FAILED_COPY} errorCode={failure.code} data-testid="project-edit-error" />}
        <Field label="Name" {...(errors.name === undefined ? {} : { error: errors.name })}>
          {(control) => (
            <Input
              {...control}
              data-testid="project-edit-name"
              value={name}
              maxLength={MAX_PROJECT_NAME_LENGTH * 2}
              autoComplete="off"
              invalid={errors.name !== undefined}
              onChange={(event) => {
                setName(event.target.value);
                setErrors((prev) => ({ ...prev, name: undefined }));
              }}
            />
          )}
        </Field>
        <Field label="Description" help="Optional." {...(errors.description === undefined ? {} : { error: errors.description })}>
          {(control) => (
            <Textarea
              {...control}
              data-testid="project-edit-description"
              rows={3}
              value={description}
              maxLength={MAX_PROJECT_DESCRIPTION_LENGTH}
              onChange={(event) => {
                setDescription(event.target.value);
                setErrors((prev) => ({ ...prev, description: undefined }));
              }}
            />
          )}
        </Field>
      </form>
    </Sheet>
  );
}
