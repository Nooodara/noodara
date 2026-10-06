'use client';

// 13-12: the service view's toolbar. The service name with its derived status (from the API, never
// computed here), one primary action (Deploy), Cancel while a deployment can still be cancelled,
// Edit, and an overflow menu with redeploy, stop, restart, remove container and delete service.
// Delete goes through ConfirmByNameDialog with the exact service name.
//
// Action safety (H1): one request at a time. A ref drops a second click before React re-renders,
// and the actions sit in a disabled <fieldset> while a request is pending, so a double click
// queues exactly one deployment. A 409 that means the state moved (DEPLOYMENT_IN_PROGRESS,
// DEPLOYMENT_NOT_CANCELLABLE) refreshes the view and shows one calm recovery line instead of an
// error. Failures show fixed copy, never the server's text.
//
// The bar is a solid surface: the repo's backdrop-filter budget (UI-10) is already spent by
// Toolbar, ServerDetailToolbar and Sheet.
import Link from 'next/link';
import { useId, useRef, useState } from 'react';
import { Button, cn, RowMenu, type Tone } from '@noodara/ui';
import {
  cancelDeployment,
  deleteService,
  deployService,
  redeployService,
  runServiceOperation,
  type DeployApiResult,
  type DeploymentView,
  type ServiceOperation,
  type ServiceView,
} from '../lib/deploy-api';
import { RUNTIME_LOGS_INSPECTOR_HREF } from '../app/(shell)/@inspector/inspector-route';
import type { DeployApiErrorCode } from '../lib/api-client';
import { requireSession } from '../lib/require-session';
import {
  isCancellable,
  isStateRaceCode,
  PROJECT_ARCHIVED_DEPLOY_COPY,
  serviceActionCopy,
  serviceStatusPresentation,
  SERVICE_SESSION_COPY,
  type StatusPresentation,
} from '../lib/service-status-copy';
import { useShellContext } from '../lib/shell-context';
import { ConfirmByNameDialog, deleteOutcome } from './ConfirmByNameDialog';
import { projectHref } from './ProjectNav';
import { StreamStatus } from './StreamStatus';

const TONE_CLASSES: Record<Tone, string> = {
  ok: 'bg-status-ok-soft text-status-ok-text',
  warn: 'bg-status-warn-soft text-status-warn-text',
  error: 'bg-status-error-soft text-status-error-text',
  idle: 'bg-status-idle-soft text-status-idle-text',
};

const DOT_CLASSES: Record<Tone, string> = {
  ok: 'bg-status-ok',
  warn: 'bg-status-warn',
  error: 'bg-status-error',
  idle: 'bg-status-idle',
};

export interface TonePillProps {
  readonly presentation: StatusPresentation;
  readonly title?: string;
  readonly 'data-testid'?: string;
}

/** StatusPill's look (skill §4.2) for service and deployment states, which StatusPill (server
 *  states only) does not take. The word is always present: state is never color-only. */
export function TonePill({ presentation, title, 'data-testid': testId }: TonePillProps) {
  const { word, tone, pulsing } = presentation;
  return (
    <span
      data-testid={testId}
      data-tone={tone}
      title={title}
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-pill px-2 py-0.5 text-caption font-medium',
        'transition-[color,background-color] duration-[150ms] ease-[var(--ease-out)]',
        TONE_CLASSES[tone],
      )}
    >
      <span
        aria-hidden="true"
        className={cn('h-1.5 w-1.5 rounded-full', DOT_CLASSES[tone], pulsing && 'motion-safe:animate-pulse')}
      />
      {word}
    </span>
  );
}

type ActionId = 'deploy' | 'cancel' | 'redeploy' | ServiceOperation;

export interface ServiceToolbarProps {
  readonly service: ServiceView;
  readonly projectName: string;
  readonly archived: boolean;
  /** The newest deployment that has not ended, or null. */
  readonly activeDeployment: DeploymentView | null;
  /** A deployment this toolbar queued or cancelled. */
  readonly onDeploymentChange: (deployment: DeploymentView) => void;
  readonly onServiceChange: (service: ServiceView) => void;
  /** The state moved under the user: refetch the service and its history. */
  readonly onRefresh: () => void;
  readonly onEdit: () => void;
  readonly onDeleted: () => void;
}

const MENU_TEST_ID = 'service-actions-menu';

export function ServiceToolbar({
  service,
  projectName,
  archived,
  activeDeployment,
  onDeploymentChange,
  onServiceChange,
  onRefresh,
  onEdit,
  onDeleted,
}: ServiceToolbarProps) {
  const { connected } = useShellContext();
  const archivedNoteId = useId();
  const [pending, setPending] = useState<ActionId | null>(null);
  const [message, setMessage] = useState<{
    readonly kind: 'notice' | 'error';
    readonly text: string;
  } | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const inFlight = useRef(false);
  // Deployments whose cancel was accepted: a second click on Cancel does nothing.
  const cancelRequested = useRef(new Set<string>());
  const [, setCancelTick] = useState(0);

  const status = serviceStatusPresentation(service.status);
  const cancellable =
    activeDeployment !== null && isCancellable(activeDeployment.status) && !cancelRequested.current.has(activeDeployment.id);
  const cancelling = activeDeployment !== null && isCancellable(activeDeployment.status) && !cancellable;
  const deployDisabled = archived || activeDeployment !== null;

  function handleFailure(code: DeployApiErrorCode, unauthorized: boolean): void {
    if (unauthorized) {
      void requireSession();
      setMessage({ kind: 'error', text: SERVICE_SESSION_COPY });
      return;
    }
    if (isStateRaceCode(code) || code === 'PROJECT_ARCHIVED') {
      onRefresh();
      setMessage({ kind: 'notice', text: serviceActionCopy(code) });
      return;
    }
    setMessage({ kind: 'error', text: serviceActionCopy(code) });
  }

  async function run<T>(action: ActionId, request: () => Promise<DeployApiResult<T>>, onOk: (data: T) => void): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(action);
    setMessage(null);
    try {
      const result = await request();
      if (result.ok) onOk(result.data);
      else handleFailure(result.code, result.unauthorized);
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  }

  function deploy(): void {
    if (deployDisabled) return;
    void run('deploy', () => deployService(service.id), onDeploymentChange);
  }

  function cancel(): void {
    if (activeDeployment === null || !cancellable) return;
    const target = activeDeployment;
    void run(
      'cancel',
      () => cancelDeployment(target.id),
      (deployment) => {
        cancelRequested.current.add(target.id);
        setCancelTick((tick) => tick + 1);
        onDeploymentChange(deployment);
      },
    );
  }

  function operate(operation: ServiceOperation): void {
    void run(
      operation,
      () => runServiceOperation(service.projectId, service.id, operation),
      (data) => {
        onServiceChange(data.service);
      },
    );
  }

  const menuItems = [
    {
      id: 'redeploy',
      label: 'Redeploy',
      onSelect: () => {
        void run('redeploy', () => redeployService(service.projectId, service.id), onDeploymentChange);
      },
    },
    {
      id: 'stop',
      label: 'Stop',
      onSelect: () => {
        operate('stop');
      },
    },
    {
      id: 'restart',
      label: 'Restart',
      onSelect: () => {
        operate('restart');
      },
    },
    {
      id: 'remove',
      label: 'Remove container',
      onSelect: () => {
        operate('remove');
      },
    },
    {
      id: 'delete',
      label: 'Delete service',
      destructive: true,
      onSelect: () => {
        if (inFlight.current) return;
        setDeleteOpen(true);
      },
    },
  ];

  return (
    <div className="flex flex-col gap-2">
      <div
        data-testid="service-toolbar"
        className="sticky top-0 z-30 flex min-h-[52px] flex-wrap items-center gap-3 border-b border-hairline bg-surface-1 px-4 py-2"
      >
        <Link
          href={projectHref(service.projectId)}
          className="max-w-40 shrink-0 truncate text-callout text-ink-secondary hover:text-ink"
        >
          ← {projectName}
        </Link>
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <h1 className="min-w-0 truncate text-display font-semibold text-ink" title={service.name}>
            {service.name}
          </h1>
          <TonePill presentation={status} title={status.meaning} data-testid="service-status-pill" />
        </div>
        <StreamStatus connected={connected} />
        {/* 13-14: navigation, not an operation, so it stays usable while an action is pending. */}
        <Link
          href={RUNTIME_LOGS_INSPECTOR_HREF}
          scroll={false}
          data-testid="service-logs"
          className="inline-flex h-8 items-center justify-center rounded-sm px-3.5 text-callout font-medium text-ink-secondary outline-none hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Logs
        </Link>
        <fieldset
          disabled={pending !== null}
          aria-busy={pending !== null}
          data-testid="service-actions"
          className="m-0 flex min-w-0 items-center gap-2 border-0 p-0"
        >
          {cancellable || cancelling ? (
            <Button
              type="button"
              variant="secondary"
              data-testid="service-cancel"
              disabled={!cancellable}
              loading={pending === 'cancel'}
              onClick={cancel}
            >
              {cancelling ? 'Cancelling…' : 'Cancel deploy'}
            </Button>
          ) : null}
          <Button type="button" variant="ghost" data-testid="service-edit" onClick={onEdit}>
            Edit
          </Button>
          <RowMenu triggerLabel={`Actions for ${service.name}`} data-testid={MENU_TEST_ID} items={menuItems} />
          <Button
            type="button"
            variant="primary"
            data-testid="service-deploy"
            disabled={deployDisabled}
            aria-describedby={archived ? archivedNoteId : undefined}
            loading={pending === 'deploy'}
            onClick={deploy}
          >
            Deploy
          </Button>
        </fieldset>
      </div>
      {archived ? (
        <p id={archivedNoteId} data-testid="service-archived-note" className="px-4 text-caption text-ink-secondary">
          {PROJECT_ARCHIVED_DEPLOY_COPY}
        </p>
      ) : null}
      {message !== null ? (
        <p
          data-testid={message.kind === 'notice' ? 'service-toolbar-notice' : 'service-toolbar-error'}
          role={message.kind === 'notice' ? 'status' : 'alert'}
          className={cn('px-4 text-caption', message.kind === 'notice' ? 'text-ink-secondary' : 'text-status-error')}
        >
          {message.text}
        </p>
      ) : null}
      <ConfirmByNameDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete ${service.name}?`}
        body="This removes the service's container and deletes the service with its deployment history. Type the service name to confirm."
        confirmLabel="Delete service"
        requiredName={service.name}
        data-testid="service-delete-dialog"
        returnFocusTo={() => document.querySelector<HTMLElement>(`[data-testid="${MENU_TEST_ID}"]`)}
        onConfirm={async (typed) => {
          const outcome = deleteOutcome(await deleteService(service.projectId, service.id, typed), {
            SERVICE_OPERATION_IN_PROGRESS: serviceActionCopy('SERVICE_OPERATION_IN_PROGRESS'),
            DEPLOYMENT_IN_PROGRESS: serviceActionCopy('DEPLOYMENT_IN_PROGRESS'),
            SERVER_UNREACHABLE: serviceActionCopy('SERVER_UNREACHABLE'),
          });
          if (outcome.ok) onDeleted();
          return outcome;
        }}
      />
    </div>
  );
}
