'use client';

// 24-02: one secret of a scope. Name (mono), scope pill, the masked hint, version and updatedAt;
// Replace opens a masked, write-only input and asks for confirmation before sending; Delete is
// confirmed by the panel. The typed value lives only in this component's state: it is cleared
// when the replace is sent, cancelled or the row unmounts. There is no reveal control.
import { useEffect, useState, type SyntheticEvent } from 'react';
import { Button, ConfirmDialog, Field, Input, RelativeTime } from '@noodara/ui';
import { OriginPill } from './EnvRow';
import { checkSecretValue, NEXT_DEPLOY_COPY } from '../lib/env-form';
import type { SecretRowView } from '../lib/secret-api';

export interface SecretRowProps {
  readonly secret: SecretRowView;
  readonly busy: boolean;
  /** Resolves to fixed error copy, or null on success. */
  readonly onReplace: (value: string) => Promise<string | null>;
  readonly onDelete: () => void;
  readonly now?: Date;
}

export function SecretRow({ secret, busy, onReplace, onDelete, now }: SecretRowProps) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(
    () => () => {
      setValue('');
    },
    [],
  );

  const close = () => {
    setEditing(false);
    setConfirming(false);
    setValue('');
    setError(null);
  };

  const onSubmit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (busy) return;
    const checked = checkSecretValue(value);
    if (!checked.ok) {
      setError(checked.message);
      return;
    }
    setError(null);
    setConfirming(true);
  };

  const onConfirm = () => {
    const next = value;
    setConfirming(false);
    setValue('');
    void onReplace(next).then((failure) => {
      if (failure === null) close();
      else setError(failure);
    });
  };

  return (
    <li data-testid={`secret-row-${secret.id}`} className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span data-testid="secret-name" className="min-w-0 break-all font-mono text-callout font-semibold text-ink">
          {secret.name}
        </span>
        <OriginPill scope={secret.scope} data-testid="secret-scope-pill" />
        <span data-testid="secret-hint" className="font-mono text-caption text-ink-secondary">
          {secret.hint}
        </span>
        <span data-testid="secret-version" className="font-mono text-caption text-ink-secondary">
          {`v${secret.version.toString()}`}
        </span>
        {secret.updatedAt === null ? null : (
          <span data-testid="secret-updated" className="text-caption text-ink-secondary">
            Updated <RelativeTime value={secret.updatedAt} now={now ?? new Date()} />
          </span>
        )}
        {editing ? null : (
          <span className="ml-auto flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setEditing(true);
              }}
              data-testid="secret-replace"
            >
              Replace
            </Button>
            <Button type="button" variant="destructive" disabled={busy} onClick={onDelete} data-testid="secret-delete">
              Delete
            </Button>
          </span>
        )}
      </div>
      {editing ? (
        <form noValidate onSubmit={onSubmit} className="flex flex-wrap items-end gap-2" data-testid="secret-replace-form">
          <div className="min-w-[12rem] flex-1">
            <Field label={`New value for ${secret.name}`} help={NEXT_DEPLOY_COPY} {...(error === null ? {} : { error })}>
              {(control) => (
                <Input
                  {...control}
                  type="password"
                  mono
                  invalid={error !== null}
                  value={value}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => {
                    setValue(event.target.value);
                    if (error !== null) setError(null);
                  }}
                  data-testid="secret-replace-value"
                />
              )}
            </Field>
          </div>
          <Button type="button" variant="ghost" onClick={close} data-testid="secret-replace-cancel">
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy} data-testid="secret-replace-save">
            Replace value
          </Button>
        </form>
      ) : null}
      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          if (!open) setConfirming(false);
        }}
        title={`Replace ${secret.name}?`}
        body={`The current value is overwritten and cannot be recovered. Variables that reference ${secret.name} get the new value on the next deploy.`}
        confirmLabel="Replace value"
        onConfirm={onConfirm}
        data-testid="secret-replace-confirm"
      />
    </li>
  );
}
