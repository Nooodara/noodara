'use client';

// 19-02: how Noodara decides a deploy is healthy, and whether a failed deploy rolls back. The
// default is "Container is running"; HTTP and TCP reveal only their own fields (progressive
// disclosure). Validation lives in lib/healthcheck-form.ts (the domain validator).
import { useId } from 'react';
import { Field, Input } from '@noodara/ui';
import {
  AUTO_ROLLBACK_HELP,
  AUTO_ROLLBACK_LABEL,
  HEALTHCHECK_KIND_OPTIONS,
  type HealthcheckFormErrors,
  type HealthcheckFormField,
  type HealthcheckFormValues,
} from '../lib/healthcheck-form';

export interface HealthcheckFieldsProps {
  readonly values: HealthcheckFormValues;
  readonly errors: HealthcheckFormErrors;
  readonly onChange: (patch: Partial<HealthcheckFormValues>, field: HealthcheckFormField) => void;
}

export function HealthcheckFields({ values, errors, onChange }: HealthcheckFieldsProps) {
  const id = useId();
  const switchId = `${id}-rollback`;
  const portError = errors.port;
  const pathError = errors.path;
  const statusesError = errors.statuses;
  const generalError = errors.healthcheck;
  return (
    <div className="flex flex-col gap-4" data-testid="healthcheck-fields">
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 text-callout font-medium text-ink">Healthcheck</legend>
        <div className="flex flex-col divide-y divide-hairline rounded-md border border-hairline">
          {HEALTHCHECK_KIND_OPTIONS.map((option) => (
            <label key={option.value} className="flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2">
              <input
                type="radio"
                name={`${id}-kind`}
                value={option.value}
                checked={values.kind === option.value}
                className="accent-[var(--accent)]"
                onChange={() => {
                  onChange({ kind: option.value }, 'kind');
                }}
              />
              <span className="flex min-w-0 flex-col">
                <span className="text-callout text-ink">{option.label}</span>
                <span className="text-caption text-ink-secondary">{option.help}</span>
              </span>
            </label>
          ))}
        </div>
        {generalError === undefined ? null : (
          <p role="alert" className="text-caption text-status-error-text" data-testid="healthcheck-error">
            {generalError}
          </p>
        )}
      </fieldset>

      {values.kind === 'container' ? null : (
        <div className="flex flex-col gap-4" data-testid="healthcheck-probe-fields">
          {values.kind === 'http' ? (
            <Field label="Path" help="For example /health." {...(pathError === undefined ? {} : { error: pathError })}>
              {(control) => (
                <Input
                  {...control}
                  mono
                  data-testid="healthcheck-path"
                  value={values.path}
                  autoComplete="off"
                  spellCheck={false}
                  invalid={pathError !== undefined}
                  onChange={(event) => {
                    onChange({ path: event.target.value }, 'path');
                  }}
                />
              )}
            </Field>
          ) : null}
          <Field label="Port" help="Empty uses the container port." {...(portError === undefined ? {} : { error: portError })}>
            {(control) => (
              <Input
                {...control}
                mono
                inputMode="numeric"
                data-testid="healthcheck-port"
                value={values.port}
                autoComplete="off"
                invalid={portError !== undefined}
                onChange={(event) => {
                  onChange({ port: event.target.value }, 'port');
                }}
              />
            )}
          </Field>
          {values.kind === 'http' ? (
            <Field
              label="Expected status"
              help="Empty accepts 200 to 399. Or list codes and ranges, like 200, 204, 300-399."
              {...(statusesError === undefined ? {} : { error: statusesError })}
            >
              {(control) => (
                <Input
                  {...control}
                  mono
                  data-testid="healthcheck-statuses"
                  value={values.statuses}
                  autoComplete="off"
                  spellCheck={false}
                  invalid={statusesError !== undefined}
                  onChange={(event) => {
                    onChange({ statuses: event.target.value }, 'statuses');
                  }}
                />
              )}
            </Field>
          ) : null}
        </div>
      )}

      <div className="flex items-start justify-between gap-4" data-testid="auto-rollback">
        <div className="flex min-w-0 flex-col gap-0.5">
          <label htmlFor={switchId} className="text-callout font-medium text-ink">
            {AUTO_ROLLBACK_LABEL}
          </label>
          <span className="text-caption text-ink-secondary">{AUTO_ROLLBACK_HELP}</span>
        </div>
        <input
          id={switchId}
          type="checkbox"
          role="switch"
          aria-checked={values.autoRollback}
          checked={values.autoRollback}
          className="mt-1 size-5 shrink-0 accent-[var(--accent)]"
          onChange={(event) => {
            onChange({ autoRollback: event.target.checked }, 'kind');
          }}
        />
      </div>
    </div>
  );
}
