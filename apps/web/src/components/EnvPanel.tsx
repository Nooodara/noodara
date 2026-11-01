'use client';

// 24-02: the variables of one scope (project, environment or service). Inline add (key, value and
// "Use a secret" with the secrets visible from that scope) checked with the shared validators;
// each row (EnvRow) edits in place; delete asks first. Every edit states that it applies on the
// next deploy. Failures render fixed copy (envFailureCopy), never a raw code or server text.
import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { Button, ConfirmDialog, Field, Input } from '@noodara/ui';
import { EnvRow, SecretPicker } from './EnvRow';
import {
  createVariable,
  deleteVariable,
  listVariables,
  updateVariable,
  type EnvApiResult,
  type EnvOwner,
  type VariableRowView,
} from '../lib/env-api';
import { checkVariableInput, envFailureCopy, NEXT_DEPLOY_COPY } from '../lib/env-form';
import { requireSession } from '../lib/require-session';
import { listVisibleSecrets, type SecretRowView } from '../lib/secret-api';

export const VARIABLES_LOAD_FAILED_COPY = "Couldn't load the variables. Check your connection and try again.";
export const VARIABLES_EMPTY_COPY = 'No variables in this scope yet.';

type Load = 'loading' | 'ready' | 'failed';

export interface EnvPanelProps {
  readonly owner: EnvOwner;
  /** Called after any successful write, so an effective view can refetch. */
  readonly onChanged?: () => void;
  /** Bumped by the parent when secrets change, so the picker refetches. */
  readonly secretsVersion?: number;
}

function failureText(result: EnvApiResult<unknown>): string | null {
  if (result.ok) return null;
  if (result.unauthorized) void requireSession();
  return envFailureCopy(result);
}

function ownerKey(owner: EnvOwner): string {
  return owner.scope === 'project'
    ? `p:${owner.projectId}`
    : owner.scope === 'environment'
      ? `e:${owner.projectId}:${owner.environmentId}`
      : `s:${owner.projectId}:${owner.serviceId}:${owner.environmentId}`;
}

export function EnvPanel({ owner, onChanged, secretsVersion = 0 }: EnvPanelProps) {
  const [load, setLoad] = useState<Load>('loading');
  const [items, setItems] = useState<readonly VariableRowView[]>([]);
  const [secrets, setSecrets] = useState<readonly SecretRowView[]>([]);
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [fieldError, setFieldError] = useState<{ readonly field: 'key' | 'value'; readonly message: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');
  const [confirm, setConfirm] = useState<VariableRowView | null>(null);
  const mounted = useRef(true);
  const stableKey = ownerKey(owner);
  const ownerRef = useRef(owner);
  ownerRef.current = owner;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const result = await listVariables(ownerRef.current);
    if (!mounted.current) return;
    if (!result.ok) {
      if (result.unauthorized) void requireSession();
      setLoad((prev) => (prev === 'ready' ? prev : 'failed'));
      return;
    }
    setItems(result.data);
    setLoad('ready');
  }, [stableKey]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void listVisibleSecrets(ownerRef.current).then((result) => {
      if (mounted.current && result.ok) setSecrets(result.data);
    });
  }, [stableKey, secretsVersion]);

  const changed = (text: string) => {
    setAnnounce(text);
    onChanged?.();
  };

  const onSubmit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (adding) return;
    const checked = checkVariableInput(key, value);
    if (!checked.ok) {
      setFieldError({ field: checked.field === 'key' ? 'key' : 'value', message: checked.message });
      return;
    }
    setFieldError(null);
    setError(null);
    setAdding(true);
    void createVariable(owner, checked.key, checked.value).then((result) => {
      if (!mounted.current) return;
      setAdding(false);
      if (!result.ok) {
        const text = failureText(result) ?? '';
        if (result.code === 'ENV_KEY_DUPLICATE') setFieldError({ field: 'key', message: text });
        else if (result.code === 'SECRET_NOT_FOUND' || result.reason !== undefined) setFieldError({ field: 'value', message: text });
        else setError(text);
        return;
      }
      setKey('');
      setValue('');
      setItems((current) => [...current.filter((entry) => entry.id !== result.data.id), result.data]);
      changed(`${result.data.key} added. ${NEXT_DEPLOY_COPY}`);
    });
  };

  const setBusy = (id: string, on: boolean) => {
    setBusyIds((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const onSave = async (variable: VariableRowView, next: string): Promise<string | null> => {
    setBusy(variable.id, true);
    setError(null);
    const result = await updateVariable(owner, variable.id, next);
    if (!mounted.current) return null;
    setBusy(variable.id, false);
    if (!result.ok) return failureText(result);
    setItems((current) => current.map((entry) => (entry.id === result.data.id ? result.data : entry)));
    changed(`${result.data.key} saved. ${NEXT_DEPLOY_COPY}`);
    return null;
  };

  const onConfirmDelete = () => {
    const variable = confirm;
    setConfirm(null);
    if (variable === null) return;
    setBusy(variable.id, true);
    setError(null);
    void deleteVariable(owner, variable.id).then((result) => {
      if (!mounted.current) return;
      setBusy(variable.id, false);
      if (!result.ok && result.code !== 'NOT_FOUND') {
        setError(failureText(result));
        return;
      }
      setItems((current) => current.filter((entry) => entry.id !== variable.id));
      changed(`${variable.key} deleted. ${NEXT_DEPLOY_COPY}`);
    });
  };

  return (
    <section aria-label="Variables" data-testid={`env-panel-${owner.scope}`} className="flex flex-col gap-4">
      <p data-testid="env-next-deploy" className="text-caption text-ink-secondary">
        {NEXT_DEPLOY_COPY}
      </p>
      <form noValidate onSubmit={onSubmit} className="flex flex-col gap-2" data-testid="env-add-form">
        <div className="flex flex-wrap items-start gap-2">
          <div className="min-w-[10rem] flex-1">
            <Field label="Name" {...(fieldError?.field === 'key' ? { error: fieldError.message } : {})}>
              {(control) => (
                <Input
                  {...control}
                  mono
                  invalid={fieldError?.field === 'key'}
                  value={key}
                  placeholder="DATABASE_URL"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={128}
                  onChange={(event) => {
                    setKey(event.target.value);
                    if (fieldError !== null) setFieldError(null);
                  }}
                  data-testid="env-add-key"
                />
              )}
            </Field>
          </div>
          <div className="min-w-[12rem] flex-[2]">
            <Field label="Value" {...(fieldError?.field === 'value' ? { error: fieldError.message } : {})}>
              {(control) => (
                <Input
                  {...control}
                  mono
                  invalid={fieldError?.field === 'value'}
                  value={value}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => {
                    setValue(event.target.value);
                    if (fieldError !== null) setFieldError(null);
                  }}
                  data-testid="env-add-value"
                />
              )}
            </Field>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SecretPicker secrets={secrets} onPick={setValue} disabled={adding} data-testid="env-add-picker" />
          <span className="ml-auto">
            <Button type="submit" variant="primary" disabled={adding} data-testid="env-add-submit">
              Add variable
            </Button>
          </span>
        </div>
      </form>

      <p role="status" aria-live="polite" data-testid="env-announce" className="sr-only">
        {announce}
      </p>
      {error === null ? null : (
        <p role="alert" data-testid="env-error" className="text-caption text-status-error-text">
          {error}
        </p>
      )}

      {load === 'loading' ? (
        <p data-testid="env-loading" className="text-callout text-ink-secondary">
          Loading variables…
        </p>
      ) : load === 'failed' ? (
        <p role="alert" data-testid="env-load-failed" className="text-callout text-status-error-text">
          {VARIABLES_LOAD_FAILED_COPY}
        </p>
      ) : items.length === 0 ? (
        <p data-testid="env-empty" className="text-callout text-ink-secondary">
          {VARIABLES_EMPTY_COPY}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-hairline" data-testid="env-list">
          {items.map((variable) => (
            <EnvRow
              key={variable.id}
              variable={variable}
              secrets={secrets}
              busy={busyIds.has(variable.id)}
              onSave={(next) => onSave(variable, next)}
              onDelete={() => {
                setConfirm(variable);
              }}
            />
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title={confirm === null ? 'Delete variable?' : `Delete ${confirm.key}?`}
        body={confirm === null ? '' : `${confirm.key} is removed from this scope. ${NEXT_DEPLOY_COPY}`}
        confirmLabel="Delete variable"
        onConfirm={onConfirmDelete}
        data-testid="env-delete-confirm"
      />
    </section>
  );
}
