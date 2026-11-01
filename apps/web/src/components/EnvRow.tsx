'use client';

// 24-02: one variable of a scope. Key in mono, the value as text (a `<secret:name>` reference is
// a chip with the secret's name, never a value), the origin pill, Edit and Delete. Edit is inline:
// the value field plus "Use a secret", checked with the shared validator before save. Everything
// renders as React text; nothing here is HTML.
import { useId, useState, type SyntheticEvent } from 'react';
import { Button, Field, Input, TonePill, cn } from '@noodara/ui';
import type { VariableRowView } from '../lib/env-api';
import { checkVariableValue, NEXT_DEPLOY_COPY, scopeLabel, secretRefName, secretReference } from '../lib/env-form';
import type { SecretRowView } from '../lib/secret-api';

export function SecretChip({ name, 'data-testid': testId = 'secret-chip' }: { readonly name: string; readonly 'data-testid'?: string }) {
  return (
    <span
      data-testid={testId}
      className="inline-flex max-w-full items-center gap-1 rounded-pill border border-hairline bg-surface-2 px-2 py-0.5 text-caption text-ink"
    >
      <span className="text-ink-secondary">Secret</span>
      <span className="truncate font-mono">{name}</span>
    </span>
  );
}

export function OriginPill({ scope, 'data-testid': testId = 'origin-pill' }: { readonly scope: string; readonly 'data-testid'?: string }) {
  return <TonePill tone="idle" label={scopeLabel(scope)} data-testid={testId} />;
}

/** A plain value as text, or the secret chip for a reference. */
export function VariableValue({ value }: { readonly value: string }) {
  const ref = secretRefName(value);
  if (ref !== null) return <SecretChip name={ref} />;
  return (
    <span data-testid="variable-value" className="min-w-0 break-all font-mono text-callout text-ink">
      {value}
    </span>
  );
}

export interface SecretPickerProps {
  readonly secrets: readonly SecretRowView[];
  readonly onPick: (reference: string) => void;
  readonly disabled?: boolean;
  readonly 'data-testid'?: string;
}

/** "Use a secret": the secrets visible from the scope, by name and scope. Picking writes the reference. */
export function SecretPicker({ secrets, onPick, disabled = false, 'data-testid': testId = 'secret-picker' }: SecretPickerProps) {
  const id = useId();
  return (
    <span className="flex items-center gap-2">
      <label htmlFor={id} className="text-caption text-ink-secondary">
        Use a secret
      </label>
      <select
        id={id}
        value=""
        disabled={disabled || secrets.length === 0}
        onChange={(event) => {
          if (event.target.value !== '') onPick(secretReference(event.target.value));
        }}
        data-testid={testId}
        className={cn(
          'h-9 rounded-sm border border-hairline bg-surface-2 px-2 text-caption text-ink',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent',
        )}
      >
        <option value="">{secrets.length === 0 ? 'No secrets yet' : 'Choose…'}</option>
        {secrets.map((secret) => (
          <option key={secret.id} value={secret.name}>
            {`${secret.name} (${scopeLabel(secret.scope)})`}
          </option>
        ))}
      </select>
    </span>
  );
}

export interface EnvRowProps {
  readonly variable: VariableRowView;
  readonly secrets: readonly SecretRowView[];
  readonly busy: boolean;
  /** Resolves to fixed error copy, or null on success. */
  readonly onSave: (value: string) => Promise<string | null>;
  readonly onDelete: () => void;
}

export function EnvRow({ variable, secrets, busy, onSave, onDelete }: EnvRowProps) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const onSubmit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (busy) return;
    const checked = checkVariableValue(value);
    if (!checked.ok) {
      setError(checked.message);
      return;
    }
    setError(null);
    void onSave(checked.value).then((failure) => {
      if (failure === null) {
        setEditing(false);
        setValue('');
      } else setError(failure);
    });
  };

  return (
    <li data-testid={`env-row-${variable.id}`} className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span data-testid="variable-key" className="min-w-0 break-all font-mono text-callout font-semibold text-ink">
          {variable.key}
        </span>
        <VariableValue value={variable.value} />
        <OriginPill scope={variable.scope} />
        {editing ? null : (
          <span className="ml-auto flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setValue(variable.value);
                setError(null);
                setEditing(true);
              }}
              data-testid="variable-edit"
            >
              Edit
            </Button>
            <Button type="button" variant="destructive" disabled={busy} onClick={onDelete} data-testid="variable-delete">
              Delete
            </Button>
          </span>
        )}
      </div>
      {editing ? (
        <form noValidate onSubmit={onSubmit} className="flex flex-col gap-2" data-testid="variable-edit-form">
          <Field label={`Value of ${variable.key}`} help={NEXT_DEPLOY_COPY} {...(error === null ? {} : { error })}>
            {(control) => (
              <Input
                {...control}
                mono
                invalid={error !== null}
                value={value}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  setValue(event.target.value);
                  if (error !== null) setError(null);
                }}
                data-testid="variable-edit-value"
              />
            )}
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <SecretPicker secrets={secrets} onPick={setValue} disabled={busy} data-testid="variable-edit-picker" />
            <span className="ml-auto flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setEditing(false);
                  setValue('');
                  setError(null);
                }}
                data-testid="variable-edit-cancel"
              >
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={busy} data-testid="variable-edit-save">
                Save
              </Button>
            </span>
          </div>
        </form>
      ) : null}
    </li>
  );
}
