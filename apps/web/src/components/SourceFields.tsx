'use client';

// 13-11 A1: the service source. A segmented control picks Git (repository, root Dockerfile),
// Dockerfile (repository plus build paths) or Image; only that mode's fields render. Errors come
// from service-form.ts (domain validators client-side, or the server's error mapped to a field).
import { Field, Input, SegmentedControl } from '@noodara/ui';
import {
  SOURCE_MODE_OPTIONS,
  type ServiceFormErrors,
  type ServiceFormField,
  type ServiceFormValues,
  type SourceMode,
} from '../lib/service-form';

export interface SourceFieldsProps {
  readonly values: ServiceFormValues;
  readonly errors: ServiceFormErrors;
  readonly onChange: (patch: Partial<ServiceFormValues>, field: ServiceFormField) => void;
}

type TextField = 'repositoryUrl' | 'branch' | 'buildContext' | 'dockerfilePath' | 'target' | 'imageRef';

interface TextSpec {
  readonly field: TextField;
  readonly label: string;
  readonly help?: string;
  readonly placeholder?: string;
}

const REPOSITORY_FIELDS: readonly TextSpec[] = [
  {
    field: 'repositoryUrl',
    label: 'Repository',
    help: 'https://host/owner/repo.git, ssh://git@host/owner/repo.git or git@host:owner/repo.git.',
    placeholder: 'https://github.com/owner/repo.git',
  },
  { field: 'branch', label: 'Branch' },
];

const DOCKERFILE_FIELDS: readonly TextSpec[] = [
  { field: 'buildContext', label: 'Build context', help: 'Relative to the repository root. "." is the root.' },
  { field: 'dockerfilePath', label: 'Dockerfile path', help: 'Relative to the repository root.' },
  { field: 'target', label: 'Build target', help: 'Optional. A stage name from a multi-stage Dockerfile.' },
];

const IMAGE_FIELDS: readonly TextSpec[] = [
  {
    field: 'imageRef',
    label: 'Image',
    help: 'Include a tag or digest, for example nginx:1.27 or ghcr.io/owner/app:1.2.0.',
    placeholder: 'registry/name:tag',
  },
];

function fieldsFor(mode: SourceMode): readonly TextSpec[] {
  if (mode === 'image') return IMAGE_FIELDS;
  return mode === 'dockerfile' ? [...REPOSITORY_FIELDS, ...DOCKERFILE_FIELDS] : REPOSITORY_FIELDS;
}

export function SourceFields({ values, errors, onChange }: SourceFieldsProps) {
  const sourceError = errors.source;
  return (
    <div className="flex flex-col gap-4" data-testid="source-fields">
      <div className="flex flex-col gap-1.5">
        <span className="text-callout font-medium text-ink" id="service-source-label">
          Source
        </span>
        <SegmentedControl<SourceMode>
          data-testid="source-mode"
          value={values.mode}
          options={SOURCE_MODE_OPTIONS}
          onValueChange={(mode) => {
            onChange({ mode }, 'source');
          }}
        />
        {sourceError === undefined ? null : (
          <p role="alert" className="text-caption text-status-error-text" data-testid="source-error">
            {sourceError}
          </p>
        )}
      </div>
      {fieldsFor(values.mode).map((spec) => {
        const error = errors[spec.field];
        return (
          <Field
            key={spec.field}
            label={spec.label}
            {...(spec.help === undefined ? {} : { help: spec.help })}
            {...(error === undefined ? {} : { error })}
          >
            {(control) => (
              <Input
                {...control}
                mono
                data-testid={`source-${spec.field}`}
                value={values[spec.field]}
                autoComplete="off"
                spellCheck={false}
                {...(spec.placeholder === undefined ? {} : { placeholder: spec.placeholder })}
                invalid={error !== undefined}
                onChange={(event) => {
                  onChange({ [spec.field]: event.target.value }, spec.field);
                }}
              />
            )}
          </Field>
        );
      })}
    </div>
  );
}
