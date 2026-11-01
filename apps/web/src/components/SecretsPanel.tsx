'use client';

// 24-02: the secrets of one scope. Create takes a name and a masked, write-only value; the value
// lives only in component state, is cleared when the request is sent and on unmount, and is never
// echoed back (rows show name, scope, hint, version and updatedAt). Replace and delete ask first; a
// SECRET_IN_USE delete lists the referencing variables (scope and key). No reveal control exists.
import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { Button, ConfirmDialog, Field, Input } from '@noodara/ui';
import { SecretRow } from './SecretRow';
import type { ApiFailure, DeployApiErrorCode } from '../lib/api-client';
import type { EnvApiResult, EnvOwner } from '../lib/env-api';
import {
  checkSecretName,
  checkSecretValue,
  envFailureCopy,
  NEXT_DEPLOY_COPY,
  scopeLabel,
  SECRET_WRITE_ONLY_COPY,
} from '../lib/env-form';
import { requireSession } from '../lib/require-session';
import {
  createSecret,
  deleteSecret,
  listSecrets,
  replaceSecret,
  type SecretRowView,
  type SecretUsage,
} from '../lib/secret-api';

export const SECRETS_LOAD_FAILED_COPY = "Couldn't load the secrets. Check your connection and try again.";
export const SECRETS_EMPTY_COPY = 'No secrets in this scope yet.';
export const SECRET_IN_USE_COPY = 'This secret is still referenced by these variables. Change or delete them first:';

type Load = 'loading' | 'ready' | 'failed';

export interface SecretsPanelProps {
  readonly owner: EnvOwner;
  /** Called after any successful write (the parent refreshes pickers and the effective view). */
  readonly onChanged?: () => void;
  readonly now?: Date;
}

function failureText(failure: ApiFailure<DeployApiErrorCode>): string {
  if (failure.unauthorized) void requireSession();
  return envFailureCopy(failure);
}

function ownerKey(owner: EnvOwner): string {
  return owner.scope === 'project'
    ? `p:${owner.projectId}`
    : owner.scope === 'environment'
      ? `e:${owner.projectId}:${owner.environmentId}`
      : `s:${owner.projectId}:${owner.serviceId}`;
}

export function SecretsPanel({ owner, onChanged, now }: SecretsPanelProps) {
  const [load, setLoad] = useState<Load>('loading');
  const [items, setItems] = useState<readonly SecretRowView[]>([]);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [fieldError, setFieldError] = useState<{ readonly field: 'name' | 'value'; readonly message: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [inUse, setInUse] = useState<{ readonly name: string; readonly usedBy: readonly SecretUsage[] } | null>(null);
  const [announce, setAnnounce] = useState('');
  const [confirm, setConfirm] = useState<SecretRowView | null>(null);
  const mounted = useRef(true);
  const stableKey = ownerKey(owner);
  const ownerRef = useRef(owner);
  ownerRef.current = owner;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      setValue('');
    };
  }, []);

  const refresh = useCallback(async () => {
    const result = await listSecrets(ownerRef.current);
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

  const setBusy = (id: string, on: boolean) => {
    setBusyIds((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const onSubmit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (creating) return;
    const checkedName = checkSecretName(name);
    if (!checkedName.ok) {
      setFieldError({ field: 'name', message: checkedName.message });
      return;
    }
    const checkedValue = checkSecretValue(value);
    if (!checkedValue.ok) {
      setFieldError({ field: 'value', message: checkedValue.message });
      return;
    }
    // The value leaves component state the moment it is sent, success or not.
    setValue('');
    setFieldError(null);
    setError(null);
    setCreating(true);
    void createSecret(owner, checkedName.name, checkedValue.value).then((result: EnvApiResult<SecretRowView>) => {
      if (!mounted.current) return;
      setCreating(false);
      if (!result.ok) {
        const text = failureText(result);
        if (result.code === 'SECRET_NAME_DUPLICATE') setFieldError({ field: 'name', message: text });
        else setError(text);
        return;
      }
      setName('');
      setItems((current) => [...current.filter((entry) => entry.id !== result.data.id), result.data]);
      setAnnounce(`${result.data.name} created`);
      onChanged?.();
    });
  };

  const onReplace = async (secret: SecretRowView, next: string): Promise<string | null> => {
    setBusy(secret.id, true);
    setError(null);
    const result = await replaceSecret(owner, secret.id, next);
    if (!mounted.current) return null;
    setBusy(secret.id, false);
    if (!result.ok) return failureText(result);
    setItems((current) => current.map((entry) => (entry.id === result.data.id ? result.data : entry)));
    setAnnounce(`${result.data.name} replaced. ${NEXT_DEPLOY_COPY}`);
    onChanged?.();
    return null;
  };

  const onConfirmDelete = () => {
    const secret = confirm;
    setConfirm(null);
    if (secret === null) return;
    setBusy(secret.id, true);
    setError(null);
    setInUse(null);
    void deleteSecret(owner, secret.id).then((result) => {
      if (!mounted.current) return;
      setBusy(secret.id, false);
      if (!result.ok && result.code === 'SECRET_IN_USE') {
        setInUse({ name: secret.name, usedBy: result.usedBy ?? [] });
        return;
      }
      if (!result.ok && result.code !== 'NOT_FOUND') {
        setError(failureText(result));
        return;
      }
      setItems((current) => current.filter((entry) => entry.id !== secret.id));
      setAnnounce(`${secret.name} deleted`);
      onChanged?.();
    });
  };

  return (
    <section aria-label="Secrets" data-testid={`secrets-panel-${owner.scope}`} className="flex flex-col gap-4">
      <p className="text-caption text-ink-secondary">{SECRET_WRITE_ONLY_COPY}</p>
      <form noValidate onSubmit={onSubmit} className="flex flex-wrap items-start gap-2" data-testid="secret-create-form">
        <div className="min-w-[10rem] flex-1">
          <Field label="Secret name" {...(fieldError?.field === 'name' ? { error: fieldError.message } : {})}>
            {(control) => (
              <Input
                {...control}
                mono
                invalid={fieldError?.field === 'name'}
                value={name}
                placeholder="database_password"
                autoComplete="off"
                spellCheck={false}
                maxLength={64}
                onChange={(event) => {
                  setName(event.target.value);
                  if (fieldError !== null) setFieldError(null);
                }}
                data-testid="secret-create-name"
              />
            )}
          </Field>
        </div>
        <div className="min-w-[12rem] flex-[2]">
          <Field label="Secret value" {...(fieldError?.field === 'value' ? { error: fieldError.message } : {})}>
            {(control) => (
              <Input
                {...control}
                type="password"
                mono
                invalid={fieldError?.field === 'value'}
                value={value}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  setValue(event.target.value);
                  if (fieldError !== null) setFieldError(null);
                }}
                data-testid="secret-create-value"
              />
            )}
          </Field>
        </div>
        <div className="self-end">
          <Button type="submit" variant="primary" disabled={creating} data-testid="secret-create-submit">
            Add secret
          </Button>
        </div>
      </form>

      <p role="status" aria-live="polite" data-testid="secrets-announce" className="sr-only">
        {announce}
      </p>
      {error === null ? null : (
        <p role="alert" data-testid="secrets-error" className="text-caption text-status-error-text">
          {error}
        </p>
      )}
      {inUse === null ? null : (
        <div role="alert" data-testid="secret-in-use" className="flex flex-col gap-1 text-caption text-status-error-text">
          <p>{SECRET_IN_USE_COPY}</p>
          <ul className="flex flex-col gap-0.5">
            {inUse.usedBy.map((usage) => (
              <li key={`${usage.scope}:${usage.key}`} data-testid="secret-in-use-item" className="text-ink">
                <span className="font-mono">{usage.key}</span>
                <span className="text-ink-secondary">{` (${scopeLabel(usage.scope)})`}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {load === 'loading' ? (
        <p data-testid="secrets-loading" className="text-callout text-ink-secondary">
          Loading secrets…
        </p>
      ) : load === 'failed' ? (
        <p role="alert" data-testid="secrets-load-failed" className="text-callout text-status-error-text">
          {SECRETS_LOAD_FAILED_COPY}
        </p>
      ) : items.length === 0 ? (
        <p data-testid="secrets-empty" className="text-callout text-ink-secondary">
          {SECRETS_EMPTY_COPY}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-hairline" data-testid="secrets-list">
          {items.map((secret) => (
            <SecretRow
              key={secret.id}
              secret={secret}
              busy={busyIds.has(secret.id)}
              onReplace={(next) => onReplace(secret, next)}
              onDelete={() => {
                setConfirm(secret);
              }}
              {...(now === undefined ? {} : { now })}
            />
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title={confirm === null ? 'Delete secret?' : `Delete ${confirm.name}?`}
        body={confirm === null ? '' : `${confirm.name} and its value are deleted for good. Variables must stop referencing it first.`}
        confirmLabel="Delete secret"
        onConfirm={onConfirmDelete}
        data-testid="secret-delete-confirm"
      />
    </section>
  );
}
