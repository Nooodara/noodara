'use client';

// 13-10: create an environment from a sheet over the project view. The name is free (any entity
// slug); production, staging and development are one-tap suggestions only. One POST per submit
// (a ref guards the in-flight request). Server failures map to fixed copy: a taken name (409) or a
// rejected name (400/422) shows on the name field, anything else in a banner with its code. The
// typed name survives a failed submit; the form only resets when the sheet opens.
import { useEffect, useId, useRef, useState, type SyntheticEvent } from 'react';
import { ENVIRONMENT_NAME_SUGGESTIONS, validateEnvironmentName } from '@noodara/domain';
import { Banner, Button, Field, Input, Sheet, cn } from '@noodara/ui';
import { createEnvironment, type EnvironmentView } from '../lib/deploy-api';
import { requireSession } from '../lib/require-session';
import { notifyProjectsChanged } from './ProjectNav';

export interface EnvironmentSheetProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly projectId: string;
  /** Names already used in this project; matching suggestions are hidden. */
  readonly existingNames?: readonly string[];
  readonly onCreated?: (environment: EnvironmentView) => void;
}

export const ENVIRONMENT_NAME_INVALID_COPY =
  'Use lowercase letters, numbers and hyphens (up to 63 characters), starting and ending with a letter or number.';
export const ENVIRONMENT_NAME_TAKEN_COPY = 'This project already has an environment with this name. Choose another name.';
export const ENVIRONMENT_CREATE_FAILED_COPY = "Couldn't create the environment. Check your connection and try again.";
export const ENVIRONMENT_PROJECT_GONE_COPY = 'This project no longer exists. Go back to Projects.';
export const ENVIRONMENT_NOT_EMPTY_COPY =
  'This environment still has services. Remove its services first, then delete the environment.';

const CHIP_CLASSES = cn(
  'inline-flex h-8 items-center rounded-pill border border-hairline px-3 font-mono text-callout text-ink',
  'bg-surface-2 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface-3',
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
  'aria-pressed:bg-accent-soft aria-pressed:border-transparent',
);

export function EnvironmentSheet({ open, onOpenChange, projectId, existingNames = [], onCreated }: EnvironmentSheetProps) {
  const formId = useId();
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ readonly message: string; readonly code: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    if (open) {
      setName('');
      setNameError(null);
      setFailure(null);
    }
  }, [open]);

  const suggestions = ENVIRONMENT_NAME_SUGGESTIONS.filter((suggestion) => !existingNames.includes(suggestion));

  async function submit(): Promise<void> {
    if (inFlight.current) return;
    const checked = validateEnvironmentName(name);
    if (!checked.ok) {
      setNameError(ENVIRONMENT_NAME_INVALID_COPY);
      return;
    }
    inFlight.current = true;
    setSubmitting(true);
    setNameError(null);
    setFailure(null);
    const result = await createEnvironment(projectId, { name: checked.value });
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
    if (result.code === 'ENVIRONMENT_NAME_TAKEN') {
      setNameError(ENVIRONMENT_NAME_TAKEN_COPY);
      return;
    }
    if (result.code === 'VALIDATION_FAILED') {
      setNameError(ENVIRONMENT_NAME_INVALID_COPY);
      return;
    }
    if (result.code === 'NOT_FOUND') {
      setFailure({ message: ENVIRONMENT_PROJECT_GONE_COPY, code: result.code });
      return;
    }
    setFailure({ message: ENVIRONMENT_CREATE_FAILED_COPY, code: result.code });
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
      <Button type="submit" form={formId} variant="primary" data-testid="environment-sheet-submit" loading={submitting} disabled={submitting}>
        Create environment
      </Button>
    </>
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="New environment" footer={footer} data-testid="environment-sheet">
      <form id={formId} onSubmit={onSubmit} className="flex flex-col gap-6" noValidate>
        {failure === null ? null : <Banner message={failure.message} errorCode={failure.code} data-testid="environment-sheet-error" />}
        <Field
          label="Name"
          help="Any lowercase name works, for example qa or preview."
          {...(nameError === null ? {} : { error: nameError })}
        >
          {(control) => (
            <Input
              {...control}
              mono
              data-testid="environment-sheet-name"
              value={name}
              maxLength={128}
              autoComplete="off"
              spellCheck={false}
              invalid={nameError !== null}
              onChange={(event) => {
                setName(event.target.value);
                setNameError(null);
              }}
            />
          )}
        </Field>
        {suggestions.length === 0 ? null : (
          <div className="flex flex-col gap-2">
            <p className="text-caption font-medium text-ink-secondary" id={`${formId}-suggestions`}>
              Suggestions
            </p>
            <div className="flex flex-wrap gap-2" role="group" aria-labelledby={`${formId}-suggestions`}>
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className={CHIP_CLASSES}
                  aria-pressed={name === suggestion}
                  data-testid={`environment-suggestion-${suggestion}`}
                  onClick={() => {
                    setName(suggestion);
                    setNameError(null);
                  }}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}
      </form>
    </Sheet>
  );
}
