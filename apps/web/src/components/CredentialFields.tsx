'use client';

// The D-04 credential block (05-UI-SPEC.md SS2.4/SS10) -- the one place a private key or password
// enters the product. Every credential value lives only in this component's own local state, for
// the lifetime of the mounted block: it is never written to `localStorage`/`sessionStorage`, never
// logged, never placed into a second attribute, and is discarded the instant this component
// unmounts (React's own unmount behaviour, not something this file has to implement) -- the
// parent `ServerSheet`'s `Sheet` unmounts this block's whole subtree on close (packages/ui/src/
// Sheet.tsx), so closing the sheet already clears every field here with no extra code.
//
// `onChange` fires with the current `CredentialFormValue` on every keystroke/file-read/segment
// switch so the parent can hold the latest value for its own request-body builder
// (apps/web/src/lib/server-form.ts) -- this component is the single source of truth for what the
// user actually typed; the parent never re-derives or duplicates it.
import { useEffect, useState } from 'react';
import { Button, Field, FileButton, Input, SegmentedControl, Textarea } from '@noodara/ui';
import type { CredentialFormValue } from '../lib/server-form';

export interface CredentialFieldsProps {
  readonly mode: 'create' | 'edit';
  readonly onChange: (value: CredentialFormValue) => void;
  /** Edit mode only -- fires once when "Replace" is activated, so the caller can mark the
   *  credential as intentionally being replaced (feeds `buildUpdateBody`'s `credentialReplaced`
   *  flag). Never called in create mode. */
  readonly onReplace?: () => void;
  readonly error?: string;
}

type CredentialType = 'ssh_private_key' | 'ssh_password';

const CREDENTIAL_TYPE_OPTIONS = [
  { value: 'ssh_private_key', label: 'Private key' },
  { value: 'ssh_password', label: 'Password' },
] as const;

const FILE_READ_ERROR_FALLBACK = 'Could not read the selected file. Try again, or paste the value instead.';

export function CredentialFields({ mode, onChange, onReplace, error }: CredentialFieldsProps) {
  const [type, setType] = useState<CredentialType>('ssh_private_key');
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [password, setPassword] = useState('');
  const [fileError, setFileError] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);

  useEffect(() => {
    onChange(
      type === 'ssh_password'
        ? { type: 'ssh_password', password }
        : { type: 'ssh_private_key', privateKey, passphrase },
    );
    // Only the credential values themselves should retrigger this effect -- `onChange` is an
    // inline caller-provided callback whose identity can change every render, and this project's
    // eslint config has no react-hooks/exhaustive-deps rule registered to enforce including it.
  }, [type, privateKey, passphrase, password]);

  function handleTypeChange(next: CredentialType): void {
    setType(next);
    // Defense in depth beyond T-5-79 (the request-body builder already emits only the selected
    // branch's keys): the unselected branch's own in-memory value is cleared the instant it stops
    // being the active branch, rather than lingering in state for the rest of the sheet's lifetime.
    if (next === 'ssh_password') {
      setPrivateKey('');
      setPassphrase('');
    } else {
      setPassword('');
    }
  }

  if (mode === 'edit' && !replacing) {
    return (
      <div className="flex flex-col gap-1.5">
        <span className="text-callout font-medium text-ink">Credential</span>
        <div className="flex items-center gap-3">
          <span className="font-mono text-mono text-ink-tertiary">••••••••</span>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setReplacing(true);
              onReplace?.();
            }}
          >
            Replace
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <SegmentedControl
        data-testid="server-sheet-credential-type"
        value={type}
        onValueChange={handleTypeChange}
        options={CREDENTIAL_TYPE_OPTIONS}
      />
      {type === 'ssh_private_key' ? (
        <div className="flex flex-col gap-3">
          <Field label="Private key" {...(error === undefined ? {} : { error })}>
            {(controlProps) => (
              <div className="flex flex-col gap-2">
                <Textarea
                  {...controlProps}
                  mono
                  rows={6}
                  autoComplete="off"
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  invalid={error !== undefined}
                  placeholder="Paste your private key, or choose a file"
                  value={privateKey}
                  onChange={(event) => {
                    setPrivateKey(event.target.value);
                  }}
                />
                <FileButton
                  label="Choose file"
                  onText={(text) => {
                    setFileError(null);
                    setPrivateKey(text);
                  }}
                  onError={(message) => {
                    setFileError(message.length > 0 ? message : FILE_READ_ERROR_FALLBACK);
                  }}
                />
              </div>
            )}
          </Field>
          {fileError !== null ? (
            <p role="alert" className="text-caption text-status-error">
              {fileError}
            </p>
          ) : null}
          <Field label="Passphrase" help="Optional -- only if the key itself is encrypted.">
            {(controlProps) => (
              <Input
                {...controlProps}
                type="password"
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                value={passphrase}
                onChange={(event) => {
                  setPassphrase(event.target.value);
                }}
              />
            )}
          </Field>
          <p className="text-caption text-ink-tertiary">ed25519 keys are recommended.</p>
        </div>
      ) : (
        <Field label="Password" {...(error === undefined ? {} : { error })}>
          {(controlProps) => (
            <Input
              {...controlProps}
              type="password"
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              invalid={error !== undefined}
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
            />
          )}
        </Field>
      )}
    </div>
  );
}
