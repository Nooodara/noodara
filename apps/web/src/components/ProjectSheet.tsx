'use client';

// 13-09: create a project from a sheet over the projects list. Name and an optional description;
// the slug is shown as the server will derive it (same domain function), never typed. One POST per
// submit: a ref guards the in-flight request so a double click cannot send two. A duplicate name
// (409 PROJECT_NAME_TAKEN) shows on the name field; any other failure shows fixed copy, never the
// server's raw text.
import { useEffect, useId, useRef, useState, type SyntheticEvent } from 'react';
import { deriveProjectSlug, MAX_PROJECT_DESCRIPTION_LENGTH, MAX_PROJECT_NAME_LENGTH, validateProjectName } from '@noodara/domain';
import { Banner, Button, Field, Input, Sheet, Textarea } from '@noodara/ui';
import { createProject, type ProjectView } from '../lib/deploy-api';
import { requireSession } from '../lib/require-session';
import { notifyProjectsChanged } from './ProjectNav';

export interface ProjectSheetProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreated?: (project: ProjectView) => void;
}

export const PROJECT_NAME_INVALID_COPY = `Use 1-${String(MAX_PROJECT_NAME_LENGTH)} characters, without control characters.`;
export const PROJECT_NAME_TAKEN_COPY = 'A project with this name already exists. Choose another name.';
export const PROJECT_CREATE_FAILED_COPY = "Couldn't create the project. Check your connection and try again.";

export function ProjectSheet({ open, onOpenChange, onCreated }: ProjectSheetProps) {
  const formId = useId();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ readonly code: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    if (open) {
      setName('');
      setDescription('');
      setNameError(null);
      setFailure(null);
    }
  }, [open]);

  const validName = validateProjectName(name);
  const slug = validName.ok ? deriveProjectSlug(validName.value) : null;

  async function submit(): Promise<void> {
    if (inFlight.current) return;
    const checked = validateProjectName(name);
    if (!checked.ok) {
      setNameError(PROJECT_NAME_INVALID_COPY);
      return;
    }
    inFlight.current = true;
    setSubmitting(true);
    setNameError(null);
    setFailure(null);
    const trimmed = description.trim();
    const result = await createProject({ name: checked.value, description: trimmed === '' ? null : trimmed });
    inFlight.current = false;
    setSubmitting(false);

    if (result.ok) {
      notifyProjectsChanged();
      onCreated?.(result.data);
      onOpenChange(false);
      return;
    }
    if (result.unauthorized) {
      void requireSession();
      return;
    }
    if (result.code === 'PROJECT_NAME_TAKEN') {
      setNameError(PROJECT_NAME_TAKEN_COPY);
      return;
    }
    if (result.code === 'VALIDATION_FAILED') {
      setNameError(PROJECT_NAME_INVALID_COPY);
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
      <Button type="submit" form={formId} variant="primary" data-testid="project-sheet-submit" loading={submitting} disabled={submitting}>
        Create project
      </Button>
    </>
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="New project" footer={footer} data-testid="project-sheet">
      <form id={formId} onSubmit={onSubmit} className="flex flex-col gap-6" noValidate>
        {failure === null ? null : <Banner message={PROJECT_CREATE_FAILED_COPY} errorCode={failure.code} data-testid="project-sheet-error" />}
        <div className="flex flex-col gap-2">
          <Field label="Name" {...(nameError === null ? {} : { error: nameError })}>
            {(control) => (
              <Input
                {...control}
                data-testid="project-sheet-name"
                value={name}
                maxLength={MAX_PROJECT_NAME_LENGTH * 2}
                autoComplete="off"
                invalid={nameError !== null}
                onChange={(event) => {
                  setName(event.target.value);
                  setNameError(null);
                }}
              />
            )}
          </Field>
          <p className="min-w-0 truncate text-caption text-ink-secondary" data-testid="project-sheet-slug">
            {slug === null ? (
              'The slug is derived from the name.'
            ) : (
              <>
                Slug <span className="font-mono text-ink">{slug}</span>
              </>
            )}
          </p>
        </div>
        <Field label="Description" help="Optional.">
          {(control) => (
            <Textarea
              {...control}
              data-testid="project-sheet-description"
              rows={3}
              value={description}
              maxLength={MAX_PROJECT_DESCRIPTION_LENGTH}
              onChange={(event) => {
                setDescription(event.target.value);
              }}
            />
          )}
        </Field>
      </form>
    </Sheet>
  );
}
