'use client';

// The add/edit server sheet (SERV-01/SERV-02, 05-UI-SPEC.md SS2.4) -- create's primary gesture is
// D-01's "Save and connect": register, then best-effort connect, then close and land on the
// detail page; a discreet secondary "Save without connecting" leaves the server PENDING. Edit's
// single primary action is "Save" and never triggers a connect (editing an already-CONNECTED
// server must not implicitly reconnect it).
//
// Every credential value lives only inside `CredentialFields`' own local state
// (apps/web/src/components/CredentialFields.tsx) -- this component only reads the latest
// `CredentialFormValue` via its `onChange` callback to build a request body
// (apps/web/src/lib/server-form.ts), never storing or echoing the raw value anywhere else. The
// whole form's state (including that credential mirror) is reset the instant the sheet transitions
// to closed, on top of `Sheet`'s own unmount-on-close behaviour that already discards
// `CredentialFields`' internal state.
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field, Input, Sheet } from '@noodara/ui';
import { CredentialFields } from './CredentialFields';
import { apiSend, type ApiFailure, type ServerView } from '../lib/api-client';
import { copyForErrorCode, fieldErrorsFromIssues, fieldForErrorCode } from '../lib/error-copy';
import { requireSession } from '../lib/require-session';
import {
  buildCreateBody,
  buildUpdateBody,
  emptyServerFormState,
  validateServerForm,
  type CredentialFormValue,
  type ServerFormErrors,
  type ServerFormState,
} from '../lib/server-form';

export interface ServerSheetProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly mode: 'create' | 'edit';
  /** Required (and used) only in edit mode -- never read for its credential (edit never
   *  pre-fills one, SS10). */
  readonly server: ServerView | null;
  /** Called once a create/edit round trip actually succeeds, so the caller can refetch/resync its
   *  own list -- this component never owns the servers list itself. */
  readonly onSaved: () => void;
}

function formStateFromServer(server: ServerView | null): ServerFormState {
  if (server === null) {
    return emptyServerFormState();
  }
  return {
    name: server.name,
    host: server.host,
    sshPort: String(server.sshPort),
    sshUser: server.sshUser,
    credential: emptyServerFormState().credential,
  };
}

function effectivePort(state: ServerFormState): number {
  const trimmed = state.sshPort.trim();
  return trimmed === '' ? 22 : Number(trimmed);
}

/** Drops the `credential` requirement for an edit that never activated Replace -- an untouched
 *  credential is not a missing one. */
function clientErrors(state: ServerFormState, mode: 'create' | 'edit', credentialReplaced: boolean): ServerFormErrors {
  const errors = validateServerForm(state);
  if (mode === 'edit' && !credentialReplaced) {
    const { credential: _credential, ...rest } = errors;
    return rest;
  }
  return errors;
}

export function ServerSheet({ open, onOpenChange, mode, server, onSaved }: ServerSheetProps) {
  const router = useRouter();
  const [formState, setFormState] = useState<ServerFormState>(() => formStateFromServer(server));
  const [baseline, setBaseline] = useState<ServerFormState>(() => formStateFromServer(server));
  const [credentialReplaced, setCredentialReplaced] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<ServerFormErrors>({});
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Re-initializes every time the sheet transitions to open (or the edited server's identity
  // changes while already open) -- never on a stray re-render, and never on every keystroke.
  useEffect(() => {
    if (open) {
      setFormState(formStateFromServer(server));
      setBaseline(formStateFromServer(server));
      setCredentialReplaced(false);
      setFieldErrors({});
      setToastMessage(null);
      setSubmitting(false);
    }
  }, [open, mode, server?.id]);

  // Defense in depth beyond `Sheet`'s own unmount-on-close behaviour: the instant the sheet
  // closes (Cancel, the header's close button, Esc, an outside click, or a successful submit),
  // this component's own copy of the form state -- including whatever `CredentialFields` last
  // reported -- is discarded too, rather than lingering in a closed-but-still-mounted component.
  useEffect(() => {
    if (!open) {
      setFormState(emptyServerFormState());
      setCredentialReplaced(false);
    }
  }, [open]);

  function handleCredentialChange(value: CredentialFormValue): void {
    setFormState((prev) => ({ ...prev, credential: value }));
  }

  function handleApiFailure(result: ApiFailure): void {
    if (result.unauthorized) {
      setToastMessage(copyForErrorCode('UNAUTHORIZED'));
      void requireSession();
      return;
    }

    if (result.code === 'VALIDATION_FAILED' && result.issues !== undefined) {
      const mapped = fieldErrorsFromIssues(result.issues);
      if (Object.keys(mapped).length > 0) {
        setFieldErrors(mapped);
        return;
      }
    }

    if (result.code !== 'NETWORK_ERROR') {
      const field = fieldForErrorCode(result.code);
      if (field !== null) {
        let message = copyForErrorCode(result.code);
        if (field === 'name') {
          message = message.replace('{name}', formState.name);
        }
        if (field === 'host') {
          message = message.replace('{host}', formState.host).replace('{port}', String(effectivePort(formState)));
        }
        setFieldErrors({ [field]: message });
        return;
      }
    }

    setToastMessage(result.code === 'NETWORK_ERROR' ? result.message : copyForErrorCode(result.code));
  }

  async function handleSubmit(connectAfter: boolean): Promise<void> {
    if (submitting) return;

    const errors = clientErrors(formState, mode, credentialReplaced);
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    setFieldErrors({});
    setToastMessage(null);
    setSubmitting(true);

    if (mode === 'create') {
      const body = buildCreateBody(formState);
      const result = await apiSend<ServerView>('POST', '/api/servers', body);
      setSubmitting(false);

      if (!result.ok) {
        handleApiFailure(result);
        return;
      }

      const created = result.data;
      onOpenChange(false);
      onSaved();

      if (connectAfter) {
        // Best-effort: a failed connect still closes the sheet and lands on the detail page --
        // that page renders whatever state resulted, per 05-UI-SPEC.md SS2.4. The response body
        // is discarded entirely; nothing here is ever read back or polled.
        await apiSend('POST', `/api/servers/${encodeURIComponent(created.id)}/connect`);
        router.push(`/servers/${created.id}`);
      }
      // "Save without connecting" registers the server and stays on the list -- no navigation,
      // matching 05-UI-SPEC.md SS2.4's "registers and stays on the list".
      return;
    }

    if (server === null) {
      setSubmitting(false);
      return;
    }

    const body = buildUpdateBody(formState, baseline, credentialReplaced);
    const result = await apiSend<ServerView>('PATCH', `/api/servers/${encodeURIComponent(server.id)}`, body);
    setSubmitting(false);

    if (!result.ok) {
      handleApiFailure(result);
      return;
    }

    onOpenChange(false);
    onSaved();
  }

  const title = mode === 'create' ? 'Add server' : `Edit ${server?.name ?? ''}`;

  function handleCancel(): void {
    // Discards all field state, including any loaded key text -- the `open` effect above already
    // resets `formState` the instant `open` becomes false, on top of `CredentialFields`' own
    // unmount-on-close behaviour.
    onOpenChange(false);
  }

  const cancelButton = (
    <Button type="button" variant="ghost" disabled={submitting} onClick={handleCancel}>
      Cancel
    </Button>
  );

  const footer =
    mode === 'create' ? (
      <>
        {cancelButton}
        <Button type="button" variant="ghost" disabled={submitting} onClick={() => void handleSubmit(false)}>
          Save without connecting
        </Button>
        <Button
          type="button"
          variant="primary"
          data-testid="server-sheet-save-connect"
          loading={submitting}
          onClick={() => void handleSubmit(true)}
        >
          Save and connect
        </Button>
      </>
    ) : (
      <>
        {cancelButton}
        <Button type="button" variant="primary" loading={submitting} onClick={() => void handleSubmit(false)}>
          Save
        </Button>
      </>
    );

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={title} data-testid="server-sheet" footer={footer}>
      {toastMessage !== null ? (
        <p data-testid="server-sheet-toast" className="mb-4 text-caption text-status-error">
          {toastMessage}
        </p>
      ) : null}
      <form
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <Field label="Name" {...(fieldErrors.name === undefined ? {} : { error: fieldErrors.name })}>
          {(controlProps) => (
            <Input
              {...controlProps}
              autoFocus
              disabled={submitting}
              invalid={fieldErrors.name !== undefined}
              value={formState.name}
              onChange={(event) => {
                setFormState((prev) => ({ ...prev, name: event.target.value }));
              }}
            />
          )}
        </Field>
        <Field
          label="Host"
          help="Hostname or IP address"
          {...(fieldErrors.host === undefined ? {} : { error: fieldErrors.host })}
        >
          {(controlProps) => (
            <Input
              {...controlProps}
              mono
              disabled={submitting}
              invalid={fieldErrors.host !== undefined}
              value={formState.host}
              onChange={(event) => {
                setFormState((prev) => ({ ...prev, host: event.target.value }));
              }}
            />
          )}
        </Field>
        <Field label="SSH port" {...(fieldErrors.sshPort === undefined ? {} : { error: fieldErrors.sshPort })}>
          {(controlProps) => (
            <Input
              {...controlProps}
              mono
              type="number"
              placeholder="22"
              disabled={submitting}
              invalid={fieldErrors.sshPort !== undefined}
              value={formState.sshPort}
              onChange={(event) => {
                setFormState((prev) => ({ ...prev, sshPort: event.target.value }));
              }}
            />
          )}
        </Field>
        <Field label="SSH user" {...(fieldErrors.sshUser === undefined ? {} : { error: fieldErrors.sshUser })}>
          {(controlProps) => (
            <Input
              {...controlProps}
              mono
              placeholder="root"
              disabled={submitting}
              invalid={fieldErrors.sshUser !== undefined}
              value={formState.sshUser}
              onChange={(event) => {
                setFormState((prev) => ({ ...prev, sshUser: event.target.value }));
              }}
            />
          )}
        </Field>
        <CredentialFields
          mode={mode}
          onChange={handleCredentialChange}
          onReplace={() => {
            setCredentialReplaced(true);
          }}
          {...(fieldErrors.credential === undefined ? {} : { error: fieldErrors.credential })}
        />
      </form>
    </Sheet>
  );
}
