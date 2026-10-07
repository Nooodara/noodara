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
//
// 14-13: the bar is always one row. Below COMPACT_TOOLBAR_MAX_WIDTH (measured on the bar itself,
// so the sidebar and inspector count) it goes compact: the back link becomes a 44 px arrow, the
// status moves under the title, Edit and Logs move into the overflow menu, and the primary slot
// holds Deploy or, while a deployment can be cancelled, Cancel. The title keeps at least 12
// characters of its own font.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
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

/** Below this toolbar width (px) the full row no longer fits with a 12-character title. */
export const COMPACT_TOOLBAR_MAX_WIDTH = 960;

export type ToolbarLayout = 'compact' | 'full';

/** 0 means not laid out yet (first render, jsdom): keep the full layout rather than guess. */
export function toolbarLayout(width: number): ToolbarLayout {
  return width > 0 && width < COMPACT_TOOLBAR_MAX_WIDTH ? 'compact' : 'full';
}

/** The layout for the element's current width, measured before paint and on every resize. */
function useToolbarLayout(ref: RefObject<HTMLElement | null>): ToolbarLayout {
  const [layout, setLayout] = useState<ToolbarLayout>('full');
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return undefined;
    const measure = (): void => {
      setLayout(toolbarLayout(element.getBoundingClientRect().width));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [ref]);
  return layout;
}

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
  const router = useRouter();
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const layout = useToolbarLayout(toolbarRef);
  const compact = layout === 'compact';
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

  const compactItems = compact
    ? [
        { id: 'edit', label: 'Edit', onSelect: onEdit },
        {
          id: 'logs',
          label: 'Logs',
          onSelect: () => {
            router.push(RUNTIME_LOGS_INSPECTOR_HREF, { scroll: false });
          },
        },
      ]
    : [];

  const menuItems = [
    ...compactItems,
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
        ref={toolbarRef}
        data-testid="service-toolbar"
        data-layout={layout}
        className={cn(
          'sticky top-0 z-30 flex min-h-[52px] flex-nowrap items-center border-b border-hairline bg-surface-1 px-4 py-2',
          compact ? 'gap-2' : 'gap-3',
        )}
      >
        {compact ? (
          <Link
            href={projectHref(service.projectId)}
            aria-label={`Back to ${projectName}`}
            className="-ml-3 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-sm text-headline text-ink-secondary outline-none hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <span aria-hidden="true">←</span>
          </Link>
        ) : (
          <Link
            href={projectHref(service.projectId)}
            className="max-w-40 shrink-0 truncate text-callout text-ink-secondary hover:text-ink"
          >
            ← {projectName}
          </Link>
        )}
        {/* ch is relative to this block's font (the title's), so 12ch is 12 title characters. */}
        <div
          data-testid="service-title"
          className={cn(
            'flex flex-1',
            // Full: min-w-0 here (an unbroken title's min-content would otherwise widen the bar);
            // the h1 itself keeps 12ch, and COMPACT_TOOLBAR_MAX_WIDTH leaves room for it.
            compact ? 'min-w-[12ch] flex-col items-start gap-0.5 text-title' : 'min-w-0 items-center gap-3',
          )}
        >
          <h1
            className={cn(
              'truncate font-semibold text-ink',
              compact ? 'w-full min-w-0 text-title' : 'min-w-[12ch] text-display',
            )}
            title={service.name}
          >
            {service.name}
          </h1>
          <div className="flex min-w-0 items-center gap-2">
            <TonePill presentation={status} title={status.meaning} data-testid="service-status-pill" />
            {compact ? <StreamStatus connected={connected} /> : null}
          </div>
        </div>
        {compact ? null : <StreamStatus connected={connected} />}
        {/* 13-14: navigation, not an operation, so it stays usable while an action is pending. */}
        {compact ? null : (
          <Link
            href={RUNTIME_LOGS_INSPECTOR_HREF}
            scroll={false}
            data-testid="service-logs"
            className="inline-flex h-8 shrink-0 items-center justify-center rounded-sm px-3.5 text-callout font-medium text-ink-secondary outline-none hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            Logs
          </Link>
        )}
        <fieldset
          disabled={pending !== null}
          aria-busy={pending !== null}
          data-testid="service-actions"
          className={cn('m-0 flex shrink-0 items-center border-0 p-0', compact ? 'gap-1' : 'gap-2')}
        >
          {cancellable || cancelling ? (
            <Button
              type="button"
              variant="secondary"
              data-testid="service-cancel"
              hitArea={compact}
              aria-label={compact && !cancelling ? 'Cancel deploy' : undefined}
              disabled={!cancellable}
              loading={pending === 'cancel'}
              onClick={cancel}
            >
              {cancelling ? 'Cancelling…' : compact ? 'Cancel' : 'Cancel deploy'}
            </Button>
          ) : null}
          {compact ? null : (
            <Button type="button" variant="ghost" data-testid="service-edit" onClick={onEdit}>
              Edit
            </Button>
          )}
          <RowMenu
            triggerLabel={`Actions for ${service.name}`}
            data-testid={MENU_TEST_ID}
            items={menuItems}
            reveal="always"
          />
          {compact && (cancellable || cancelling) ? null : (
            <Button
              type="button"
              variant="primary"
              data-testid="service-deploy"
              hitArea={compact}
              disabled={deployDisabled}
              aria-describedby={archived ? archivedNoteId : undefined}
              loading={pending === 'deploy'}
              onClick={deploy}
            >
              Deploy
            </Button>
          )}
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
