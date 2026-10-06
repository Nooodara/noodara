'use client';

// 13-11: create or edit a service from a sheet. Name, server (create only: a service never moves),
// source (SourceFields), ports. Validation runs the @noodara/domain validators before any request;
// a server error the client did not predict is shown on its field (service-form.ts). One request
// per submit: a ref guards the in-flight call so a double click cannot send two. Private access
// (SourceCredentialFields) is edited on a saved service, outside the form, write-only.
import { useEffect, useId, useRef, useState, type SyntheticEvent } from 'react';
import { Banner, Button, Field, Input, Notice, Sheet } from '@noodara/ui';
import type { ServerView } from '../lib/api-client';
import { createService, updateService, type ServiceView } from '../lib/deploy-api';
import { requireSession } from '../lib/require-session';
import {
  buildCreateBody,
  buildEditBody,
  eligibleServers,
  emptyServiceForm,
  mapServiceFailure,
  previewEdit,
  serviceFormFromView,
  type ServiceFormErrors,
  type ServiceFormField,
  type ServiceFormValues,
} from '../lib/service-form';
import { SourceCredentialFields } from './SourceCredentialFields';
import { SourceFields } from './SourceFields';

export interface ServiceSavedInfo {
  /** True when the saved edit changed the source or a port: it applies on the next deploy. */
  readonly requiresRedeploy: boolean;
}

export interface ServiceSheetProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly projectId: string;
  readonly environmentId: string;
  /** Every server the user has; the picker keeps only the ones that can run a service. */
  readonly servers: readonly ServerView[];
  /** Present: edit this service. Absent: create a new one. */
  readonly service?: ServiceView;
  readonly onSaved?: (service: ServiceView, info: ServiceSavedInfo) => void;
}

export const V02_LIMIT_COPY =
  'Environment variables and build arguments are not part of services in v0.2. They arrive with secrets in a later version.';
export const NO_SERVERS_COPY =
  'No connected server with Docker yet. Connect a server from Servers and let discovery finish, then come back to add the service.';
export const REDEPLOY_NEEDED_COPY = 'These changes take effect after the next deploy. Redeploy the service once you save.';
export const SERVICE_SAVE_FAILED_COPY = "Couldn't save the service. Check your connection and try again.";
export const CREATE_ACCESS_COPY =
  'Private repository or registry? Create the service first, then add a token, deploy key or registry password from its settings.';

export function ServiceSheet({ open, onOpenChange, projectId, environmentId, servers, service, onSaved }: ServiceSheetProps) {
  const formId = useId();
  const editing = service !== undefined;
  const pickable = eligibleServers(servers);
  const [values, setValues] = useState<ServiceFormValues>(() => (service ? serviceFormFromView(service) : emptyServiceForm()));
  const [errors, setErrors] = useState<ServiceFormErrors>({});
  const [failure, setFailure] = useState<{ readonly code: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);

  const onlyServerId = pickable.length === 1 ? pickable[0]?.id : undefined;
  useEffect(() => {
    if (!open) return;
    setValues(service ? serviceFormFromView(service) : emptyServiceForm(onlyServerId ?? ''));
    setErrors({});
    setFailure(null);
    // Reset only when the sheet opens or the edited service changes, not on every server event.
  }, [open, service?.id]);

  const preview = service ? previewEdit(service, values) : null;

  function change(patch: Partial<ServiceFormValues>, field: ServiceFormField): void {
    setValues((previous) => ({ ...previous, ...patch }));
    setErrors((previous) => {
      if (previous[field] === undefined) return previous;
      return Object.fromEntries(Object.entries(previous).filter(([key]) => key !== field));
    });
  }

  function finish(saved: ServiceView, info: ServiceSavedInfo): void {
    onSaved?.(saved, info);
    onOpenChange(false);
  }

  async function submit(): Promise<void> {
    if (inFlight.current) return;
    const plan = service ? buildEditBody(service, values) : buildCreateBody(values);
    if (!plan.ok) {
      setErrors(plan.errors);
      return;
    }
    if (service && 'classification' in plan.body && plan.body.classification.kind === 'none') {
      onOpenChange(false);
      return;
    }
    inFlight.current = true;
    setSubmitting(true);
    setErrors({});
    setFailure(null);
    const result =
      service && 'classification' in plan.body
        ? await updateService(projectId, service.id, plan.body.body)
        : await createService(projectId, { environmentId, ...plan.body });
    inFlight.current = false;
    setSubmitting(false);

    if (result.ok) {
      if ('requiresRedeploy' in result.data) {
        finish(result.data.service, { requiresRedeploy: result.data.requiresRedeploy });
      } else {
        finish(result.data, { requiresRedeploy: false });
      }
      return;
    }
    if (result.unauthorized) {
      void requireSession();
      return;
    }
    const mapped = mapServiceFailure(result);
    if (mapped === null) setFailure({ code: result.code });
    else setErrors(mapped);
  }

  function onSubmit(event: SyntheticEvent): void {
    event.preventDefault();
    void submit();
  }

  const editedServer = editing ? servers.find((server) => server.id === service.serverId) : undefined;
  const serverError = errors.serverId;
  const nameError = errors.name;
  const internalError = errors.internalPort;
  const publishedError = errors.publishedPort;
  const blocked = !editing && pickable.length === 0;

  const footer = (
    <>
      <Button
        type="button"
        variant="ghost"
        disabled={submitting}
        onClick={() => {
          onOpenChange(false);
        }}
      >
        Cancel
      </Button>
      <Button
        type="submit"
        form={formId}
        variant="primary"
        data-testid="service-sheet-submit"
        loading={submitting}
        disabled={submitting || blocked}
      >
        {editing ? 'Save changes' : 'Create service'}
      </Button>
    </>
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={editing ? 'Edit service' : 'New service'} footer={footer} data-testid="service-sheet">
      <div className="flex flex-col gap-8">
        <form id={formId} onSubmit={onSubmit} className="flex flex-col gap-6" noValidate>
          {failure === null ? null : <Banner message={SERVICE_SAVE_FAILED_COPY} errorCode={failure.code} data-testid="service-sheet-error" />}
          <Field label="Name" help="Lowercase letters, digits and hyphens." {...(nameError === undefined ? {} : { error: nameError })}>
            {(control) => (
              <Input
                {...control}
                data-testid="service-sheet-name"
                value={values.name}
                autoComplete="off"
                spellCheck={false}
                invalid={nameError !== undefined}
                onChange={(event) => {
                  change({ name: event.target.value }, 'name');
                }}
              />
            )}
          </Field>

          {editing ? (
            <div className="flex flex-col gap-1.5" data-testid="service-sheet-server-fixed">
              <span className="text-callout font-medium text-ink">Server</span>
              <span className="text-body text-ink">{editedServer?.name ?? 'Unknown server'}</span>
              <span className="text-caption text-ink-tertiary">A service stays on its server. To move it, create it on the other server.</span>
            </div>
          ) : (
            <fieldset className="flex flex-col gap-1.5" data-testid="service-sheet-servers" aria-describedby={serverError === undefined ? undefined : `${formId}-server-error`}>
              <legend className="mb-1.5 text-callout font-medium text-ink">Server</legend>
              {pickable.length === 0 ? (
                <p className="text-caption text-ink-secondary" data-testid="service-sheet-no-servers">
                  {NO_SERVERS_COPY}{' '}
                  <a href="/servers" className="text-accent underline-offset-2 hover:underline">
                    Go to Servers
                  </a>
                </p>
              ) : (
                <div className="flex flex-col divide-y divide-hairline rounded-md border border-hairline">
                  {pickable.map((server) => (
                    <label key={server.id} className="flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2" data-testid="service-sheet-server">
                      <input
                        type="radio"
                        name={`${formId}-server`}
                        value={server.id}
                        checked={values.serverId === server.id}
                        className="accent-[var(--accent)]"
                        onChange={() => {
                          change({ serverId: server.id }, 'serverId');
                        }}
                      />
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-callout text-ink">{server.name}</span>
                        <span className="truncate font-mono text-caption text-ink-secondary">{server.host}</span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
              {serverError === undefined ? null : (
                <p id={`${formId}-server-error`} role="alert" className="text-caption text-status-error-text">
                  {serverError}
                </p>
              )}
            </fieldset>
          )}

          <SourceFields values={values} errors={errors} onChange={change} />

          <div className="grid grid-cols-2 gap-4">
            <Field label="Container port" help="The port your app listens on." {...(internalError === undefined ? {} : { error: internalError })}>
              {(control) => (
                <Input
                  {...control}
                  mono
                  inputMode="numeric"
                  data-testid="service-sheet-internal-port"
                  value={values.internalPort}
                  autoComplete="off"
                  invalid={internalError !== undefined}
                  onChange={(event) => {
                    change({ internalPort: event.target.value }, 'internalPort');
                  }}
                />
              )}
            </Field>
            <Field label="Published port" help="Optional. Empty keeps it private." {...(publishedError === undefined ? {} : { error: publishedError })}>
              {(control) => (
                <Input
                  {...control}
                  mono
                  inputMode="numeric"
                  data-testid="service-sheet-published-port"
                  value={values.publishedPort}
                  autoComplete="off"
                  invalid={publishedError !== undefined}
                  onChange={(event) => {
                    change({ publishedPort: event.target.value }, 'publishedPort');
                  }}
                />
              )}
            </Field>
          </div>

          {preview?.kind === 'redeploy' ? <Notice message={REDEPLOY_NEEDED_COPY} data-testid="service-sheet-redeploy" /> : null}

          <p className="text-caption text-ink-tertiary" data-testid="service-sheet-limit">
            {V02_LIMIT_COPY}
          </p>
        </form>

        {service ? (
          <SourceCredentialFields projectId={projectId} service={service} />
        ) : (
          <p className="text-caption text-ink-tertiary" data-testid="service-sheet-access-hint">
            {CREATE_ACCESS_COPY}
          </p>
        )}
      </div>
    </Sheet>
  );
}
