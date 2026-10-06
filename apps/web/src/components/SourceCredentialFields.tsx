'use client';

// 13-11 A3/H1/H2: private source access for a saved service. Credentials are write-only: the
// only read is presence, type and a deploy key's public half. A token or password is typed into
// an uncontrolled password input and read from the DOM once, at save, so it never sits in React
// state, form defaults, storage or the URL; the input is cleared after every attempt and unmounts
// on cancel or when the sheet closes. A failed save shows fixed copy, never the server's text.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { validateRegistryHost, validateRegistryUsername } from '@noodara/domain';
import { Banner, Button, CopyButton, Field, Input } from '@noodara/ui';
import {
  getServiceCredentials,
  removeServiceCredential,
  setRegistryCredential,
  setRepositoryCredential,
  type CredentialSlot,
  type ServiceCredentials,
  type ServiceView,
} from '../lib/deploy-api';
import { requireSession } from '../lib/require-session';
import { credentialNeedFor, type CredentialNeed } from '../lib/service-form';

export interface SourceCredentialFieldsProps {
  readonly projectId: string;
  readonly service: Pick<ServiceView, 'id' | 'sourceType' | 'repositoryUrl'>;
}

export const CREDENTIAL_SAVE_FAILED_COPY = "Couldn't save the credential. Check it and try again.";
export const CREDENTIAL_REJECTED_COPY = 'The server rejected this credential. Check its format and try again.';
export const CREDENTIAL_REMOVE_FAILED_COPY = "Couldn't remove the credential. Try again.";
export const CREDENTIAL_LOAD_FAILED_COPY = "Couldn't load access settings. Reopen the sheet to try again.";
export const DEPLOY_KEY_HELP =
  'Add this public key as a read-only deploy key in your repository settings. The private half stays on Noodara.';

const COPY: Record<CredentialNeed, { readonly title: string; readonly slot: CredentialSlot }> = {
  https_token: { title: 'Repository token', slot: 'repository' },
  deploy_key: { title: 'SSH deploy key', slot: 'repository' },
  registry_password: { title: 'Registry password', slot: 'registry' },
};

type Phase = 'idle' | 'editing' | 'saving' | 'removing';

/** Reads the secret once and empties the input in the same step. */
function takeSecret(box: HTMLElement | null): string {
  const input = box?.querySelector('input') ?? null;
  if (input === null) return '';
  const value = input.value;
  input.value = '';
  return value;
}

export function SourceCredentialFields({ projectId, service }: SourceCredentialFieldsProps) {
  const need = credentialNeedFor(service);
  const { title, slot } = COPY[need];
  const [summary, setSummary] = useState<ServiceCredentials | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [failure, setFailure] = useState<{ readonly message: string; readonly code: string } | null>(null);
  const [hasSecret, setHasSecret] = useState(false);
  const [registryHost, setRegistryHost] = useState('');
  const [registryUsername, setRegistryUsername] = useState('');
  const [fieldError, setFieldError] = useState<{ readonly host?: string; readonly username?: string }>({});
  const secretRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let live = true;
    void getServiceCredentials(projectId, service.id).then((result) => {
      if (!live) return;
      if (result.ok) setSummary(result.data);
      else if (result.unauthorized) void requireSession();
      else setLoadFailed(true);
    });
    return () => {
      live = false;
    };
  }, [projectId, service.id]);

  const current = summary?.[slot] ?? null;
  const configured = current !== null;
  const busy = phase === 'saving' || phase === 'removing';

  function closeEditor(): void {
    takeSecret(secretRef.current);
    setHasSecret(false);
    setRegistryHost('');
    setRegistryUsername('');
    setFieldError({});
    setPhase('idle');
  }

  function onFailure(result: { readonly code: string; readonly unauthorized: boolean }, copy: string): void {
    if (result.unauthorized) {
      void requireSession();
      return;
    }
    setFailure({ message: result.code === 'SERVICE_CREDENTIAL_INVALID' ? CREDENTIAL_REJECTED_COPY : copy, code: result.code });
  }

  async function generateDeployKey(): Promise<void> {
    if (busy) return;
    setPhase('saving');
    setFailure(null);
    const result = await setRepositoryCredential(projectId, service.id, { kind: 'deploy_key' });
    setPhase('idle');
    if (result.ok) setSummary(result.data);
    else onFailure(result, CREDENTIAL_SAVE_FAILED_COPY);
  }

  async function saveSecret(): Promise<void> {
    if (busy) return;
    if (need === 'registry_password') {
      const host = registryHost.trim();
      const errors: { host?: string; username?: string } = {};
      if (host !== '' && !validateRegistryHost(host).ok) errors.host = 'Use host or host:port, without scheme or path.';
      if (!validateRegistryUsername(registryUsername.trim()).ok)
        errors.username = 'Use 1-255 characters of letters, digits, ".", "_", "@" or "-".';
      if (errors.host !== undefined || errors.username !== undefined) {
        setFieldError(errors);
        return;
      }
    }
    const secret = takeSecret(secretRef.current);
    setHasSecret(false);
    if (secret === '') return;
    setPhase('saving');
    setFailure(null);
    const result =
      need === 'registry_password'
        ? await setRegistryCredential(projectId, service.id, {
            ...(registryHost.trim() === '' ? {} : { host: registryHost.trim() }),
            username: registryUsername.trim(),
            password: secret,
          })
        : await setRepositoryCredential(projectId, service.id, { kind: 'https_token', token: secret });
    if (result.ok) {
      setSummary(result.data);
      setRegistryHost('');
      setRegistryUsername('');
      setFieldError({});
      setPhase('idle');
      return;
    }
    setPhase('editing');
    onFailure(result, CREDENTIAL_SAVE_FAILED_COPY);
  }

  async function remove(): Promise<void> {
    if (busy) return;
    setPhase('removing');
    setFailure(null);
    const result = await removeServiceCredential(projectId, service.id, slot);
    setPhase('idle');
    if (result.ok) setSummary(result.data);
    else onFailure(result, CREDENTIAL_REMOVE_FAILED_COPY);
  }

  const editing = phase === 'editing' || (phase === 'saving' && need !== 'deploy_key');
  const publicKey = need === 'deploy_key' && current?.type === 'git_deploy_key' ? current.publicKey : null;

  let editor: ReactNode = null;
  if (editing) {
    editor = (
      <div className="flex flex-col gap-4" data-testid="credential-editor" role="group" aria-label={title}>
        {need === 'registry_password' ? (
          <>
            <Field label="Registry" help="Optional. Leave empty for Docker Hub." {...(fieldError.host === undefined ? {} : { error: fieldError.host })}>
              {(control) => (
                <Input
                  {...control}
                  mono
                  data-testid="credential-registry-host"
                  value={registryHost}
                  autoComplete="off"
                  spellCheck={false}
                  invalid={fieldError.host !== undefined}
                  onChange={(event) => {
                    setRegistryHost(event.target.value);
                  }}
                />
              )}
            </Field>
            <Field label="Username" {...(fieldError.username === undefined ? {} : { error: fieldError.username })}>
              {(control) => (
                <Input
                  {...control}
                  data-testid="credential-registry-username"
                  value={registryUsername}
                  autoComplete="off"
                  spellCheck={false}
                  invalid={fieldError.username !== undefined}
                  onChange={(event) => {
                    setRegistryUsername(event.target.value);
                  }}
                />
              )}
            </Field>
          </>
        ) : null}
        <div ref={secretRef}>
        <Field label={need === 'registry_password' ? 'Password' : 'Token'} help="Write-only. Noodara never shows it again.">
          {(control) => (
            <Input
              {...control}
              type="password"
              data-testid="credential-secret"
              autoComplete="off"
              spellCheck={false}
              defaultValue=""
              onChange={(event) => {
                setHasSecret(event.target.value !== '');
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void saveSecret();
                }
              }}
            />
          )}
        </Field>
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={phase === 'saving'} onClick={closeEditor} data-testid="credential-cancel">
            Cancel
          </Button>
          <Button
            type="button"
            variant="secondary"
            data-testid="credential-save"
            loading={phase === 'saving'}
            disabled={phase === 'saving' || !hasSecret}
            onClick={() => {
              void saveSecret();
            }}
          >
            Save
          </Button>
        </div>
      </div>
    );
  }

  return (
    <section className="flex flex-col gap-3" data-testid="source-credentials" aria-label="Access">
      <h3 className="text-label uppercase text-ink-secondary">Access</h3>
      {failure === null ? null : <Banner message={failure.message} errorCode={failure.code} data-testid="credential-error" />}
      {loadFailed ? <p className="text-caption text-ink-secondary">{CREDENTIAL_LOAD_FAILED_COPY}</p> : null}
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 flex-col">
          <span className="text-callout font-medium text-ink">{title}</span>
          <span className="text-caption text-ink-secondary" data-testid="credential-status">
            {summary === null ? '—' : configured ? 'Configured' : 'Not configured'}
          </span>
        </div>
        {editing || summary === null ? null : (
          <div className="flex gap-2">
            {configured ? (
              <Button
                type="button"
                variant="destructive"
                data-testid="credential-remove"
                loading={phase === 'removing'}
                disabled={busy}
                onClick={() => {
                  void remove();
                }}
              >
                Remove
              </Button>
            ) : null}
            <Button
              type="button"
              variant="secondary"
              data-testid="credential-replace"
              loading={phase === 'saving' && need === 'deploy_key'}
              disabled={busy}
              onClick={() => {
                setFailure(null);
                if (need === 'deploy_key') void generateDeployKey();
                else setPhase('editing');
              }}
            >
              {need === 'deploy_key' ? (configured ? 'Replace key' : 'Generate key') : configured ? 'Replace' : 'Add'}
            </Button>
          </div>
        )}
      </div>
      {publicKey === null ? null : (
        <div className="flex flex-col gap-2" data-testid="deploy-key">
          <div className="flex items-start gap-2 rounded-sm border border-hairline bg-surface-2 p-3">
            <code className="min-w-0 flex-1 break-all font-mono text-mono text-ink" data-testid="deploy-key-public">
              {publicKey}
            </code>
            <CopyButton value={publicKey} label="Copy public key" data-testid="deploy-key-copy" />
          </div>
          <p className="text-caption text-ink-tertiary">{DEPLOY_KEY_HELP}</p>
        </div>
      )}
      {editor}
    </section>
  );
}
