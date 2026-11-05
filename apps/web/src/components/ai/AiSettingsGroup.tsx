'use client';

// 30-04: the BYOK settings group. The key field is write-only: type password, autocomplete off, no
// `name` (a form that somehow submitted natively would carry nothing), and the key lives only in
// this component's state until the PUT that tests and stores it; a success clears it. The saved
// state shows only the server's redacted hint. Nothing here touches browser storage or the URL.
import Link from 'next/link';
import { useCallback, useEffect, useState, type ReactNode, type SyntheticEvent } from 'react';
import {
  Banner,
  Button,
  ConfirmDialog,
  Field,
  Input,
  InsetGroup,
  SegmentedControl,
  SkeletonRow,
  type SegmentedControlOption,
} from '@noodara/ui';
import {
  AI_PROVIDER_MODELS,
  deleteAiSettings,
  getAiSettings,
  putAiSettings,
  type AiProvider,
  type AiProviderSettingsView,
} from '../../lib/api/ai-api';
import { settingsFailureCopy } from './ai-copy';
import { AI_READ_ONLY_COPY } from './AiChat';

export const PROVIDER_LABELS: Readonly<Record<AiProvider, string>> = Object.freeze({
  anthropic: 'Anthropic',
  openai: 'OpenAI',
});

export const AI_DATA_SENT_COPY =
  'When you ask a question, Noodara sends the question and the results of its read-only lookups to the provider: resource names, statuses, metrics and log lines with secrets redacted. Secret values and credentials are never sent.';

const PROVIDER_OPTIONS: readonly [SegmentedControlOption<AiProvider>, SegmentedControlOption<AiProvider>] = [
  { value: 'anthropic', label: PROVIDER_LABELS.anthropic },
  { value: 'openai', label: PROVIDER_LABELS.openai },
];

const ROW_CLASSES = 'flex items-center justify-between gap-4 px-4';

type LoadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly settings: AiProviderSettingsView | null };

function modelsFor(provider: AiProvider): readonly string[] {
  return AI_PROVIDER_MODELS[provider];
}

function modelOptions(models: readonly string[]): readonly [SegmentedControlOption<string>, SegmentedControlOption<string>, ...SegmentedControlOption<string>[]] | null {
  const [first, second, ...rest] = models.map((model) => ({ value: model, label: model }));
  if (first === undefined || second === undefined) return null;
  return [first, second, ...rest];
}

function Row({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className={ROW_CLASSES} style={{ minHeight: 'var(--row-height)' }}>
      <span className="shrink-0 text-callout font-medium text-ink-secondary">{label}</span>
      <div className="flex min-w-0 flex-1 items-center justify-end gap-3">{children}</div>
    </div>
  );
}

interface KeyFormProps {
  readonly initial: AiProviderSettingsView | null;
  readonly onSaved: (settings: AiProviderSettingsView) => void;
  readonly onCancel: (() => void) | null;
}

function KeyForm({ initial, onSaved, onCancel }: KeyFormProps): ReactNode {
  const [provider, setProvider] = useState<AiProvider>(initial?.provider ?? 'anthropic');
  const [model, setModel] = useState<string>(initial?.model ?? modelsFor('anthropic')[0] ?? '');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const models = modelsFor(provider);
  const options = modelOptions(models);

  function changeProvider(next: AiProvider): void {
    setProvider(next);
    setModel(modelsFor(next)[0] ?? '');
    setError(null);
  }

  function submit(event: SyntheticEvent): void {
    event.preventDefault();
    if (saving) return;
    if (apiKey.trim() === '') {
      setError('Paste an API key to test it.');
      return;
    }
    setSaving(true);
    setError(null);
    void putAiSettings({ provider, model, apiKey: apiKey.trim() }).then((result) => {
      setSaving(false);
      if (!result.ok) {
        setError(settingsFailureCopy(result));
        return;
      }
      setApiKey('');
      onSaved(result.data);
    });
  }

  return (
    <form method="post" onSubmit={submit} noValidate data-testid="ai-settings-form" className="flex flex-col gap-4 px-4 py-4">
      <div className="flex flex-col gap-2">
        <span className="text-callout font-medium text-ink-secondary">Provider</span>
        <SegmentedControl value={provider} onValueChange={changeProvider} options={PROVIDER_OPTIONS} data-testid="ai-provider" />
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-callout font-medium text-ink-secondary">Model</span>
        {options === null ? (
          <span data-testid="ai-model" className="font-mono text-callout text-ink">
            {model}
          </span>
        ) : (
          <SegmentedControl value={model} onValueChange={setModel} options={options} data-testid="ai-model" />
        )}
      </div>
      <Field
        label="API key"
        help={initial === null ? 'The key is tested with the provider before it is saved, and it is stored encrypted.' : 'Paste a new key to replace the saved one.'}
        {...(error === null ? {} : { error })}
      >
        {(controlProps) => (
          <Input
            {...controlProps}
            type="password"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            mono
            invalid={error !== null}
            value={apiKey}
            onChange={(event) => {
              setApiKey(event.target.value);
            }}
            data-testid="ai-key-input"
          />
        )}
      </Field>
      <div className="flex items-center justify-end gap-2">
        {onCancel === null ? null : (
          <Button type="button" variant="ghost" onClick={onCancel} data-testid="ai-settings-cancel">
            Cancel
          </Button>
        )}
        <Button type="submit" variant="primary" loading={saving} disabled={saving} data-testid="ai-settings-save">
          {saving ? 'Testing key' : 'Test and save'}
        </Button>
      </div>
    </form>
  );
}

function SavedView({ settings, onReplace, onRemove }: { settings: AiProviderSettingsView; onReplace: () => void; onRemove: () => void }): ReactNode {
  return (
    <div data-testid="ai-settings-saved">
      <Row label="Provider">
        <span data-testid="ai-saved-provider" className="text-body text-ink">
          {PROVIDER_LABELS[settings.provider]}
        </span>
      </Row>
      <div className="border-t border-hairline" />
      <Row label="Model">
        <span data-testid="ai-saved-model" className="truncate font-mono text-callout text-ink">
          {settings.model}
        </span>
      </Row>
      <div className="border-t border-hairline" />
      <Row label="API key">
        <span data-testid="ai-saved-key-hint" className="font-mono text-callout text-ink">
          {settings.keyHint}
        </span>
      </Row>
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-hairline px-4 py-3">
        <Link href="/settings?ask=1" data-testid="ai-open-chat" className="mr-auto text-callout font-medium text-accent-text hover:underline">
          Ask a question
        </Link>
        <Button variant="secondary" onClick={onReplace} data-testid="ai-settings-replace">
          Replace key
        </Button>
        <Button variant="secondary" onClick={onRemove} data-testid="ai-settings-remove">
          Remove key
        </Button>
      </div>
    </div>
  );
}

export function AiSettingsGroup(): ReactNode {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [editing, setEditing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const load = useCallback((): void => {
    setState({ kind: 'loading' });
    void getAiSettings().then((result) => {
      if (!result.ok) {
        setState({ kind: 'error', message: "Couldn't load the AI settings." });
        return;
      }
      setState({ kind: 'ready', settings: result.data.settings });
    });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function remove(): void {
    setConfirmRemove(false);
    setRemoveError(null);
    void deleteAiSettings().then((result) => {
      if (!result.ok) {
        setRemoveError('The key could not be removed. Try again.');
        return;
      }
      setEditing(false);
      setState({ kind: 'ready', settings: null });
    });
  }

  let body: ReactNode;
  if (state.kind === 'loading') {
    body = <SkeletonRow data-testid="ai-settings-loading" />;
  } else if (state.kind === 'error') {
    body = (
      <div className="p-4">
        <Banner data-testid="ai-settings-error" message={state.message} action={{ label: 'Retry', onClick: load }} />
      </div>
    );
  } else if (state.settings === null || editing) {
    const saved = state.settings;
    body = (
      <KeyForm
        initial={saved}
        onSaved={(settings) => {
          setEditing(false);
          setState({ kind: 'ready', settings });
        }}
        onCancel={
          saved === null
            ? null
            : () => {
                setEditing(false);
              }
        }
      />
    );
  } else {
    body = (
      <SavedView
        settings={state.settings}
        onReplace={() => {
          setEditing(true);
        }}
        onRemove={() => {
          setConfirmRemove(true);
        }}
      />
    );
  }

  return (
    <section data-testid="ai-settings-group" className="flex flex-col gap-2">
      <InsetGroup title="AI assistant">
        <div className="flex flex-col gap-1 px-4 py-3">
          <p data-testid="ai-read-only-copy" className="text-callout text-ink">
            {AI_READ_ONLY_COPY}
          </p>
          <p data-testid="ai-data-sent-copy" className="text-caption text-ink-secondary">
            {AI_DATA_SENT_COPY}
          </p>
        </div>
        <div>{body}</div>
      </InsetGroup>
      {removeError === null ? null : (
        <p role="alert" data-testid="ai-settings-remove-error" className="text-callout text-status-error-text">
          {removeError}
        </p>
      )}
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title="Remove the API key?"
        body="The assistant stops working until you add a key again. The key is deleted from Noodara."
        confirmLabel="Remove key"
        onConfirm={remove}
        data-testid="ai-settings-remove-dialog"
      />
    </section>
  );
}
