'use client';

// 19-03: a Git service's push webhook. Enable and rotate return the secret once; it lives in this
// component's state only (never storage, URL, cache or console), is cleared on rotate, disable,
// "Hide" and unmount, and is shown with a plain "will not be shown again" statement. The panel is
// not rendered for image-source services. Recent deliveries are text-only rows: outcome, short
// SHA, time and a link to the deployment; an outcome this build does not know gets a fallback
// label. The payload URL is shown only when it passes `safePayloadUrl`.
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, ConfirmDialog, RelativeTime } from '@noodara/ui';
import { deploymentInspectorHref } from '../app/(shell)/@inspector/inspector-route';
import { requireSession } from '../lib/require-session';
import { shortSha } from '../lib/service-status-copy';
import {
  disableWebhook,
  enableWebhook,
  getWebhook,
  listWebhookDeliveries,
  rotateWebhook,
  safePayloadUrl,
  type WebhookApiResult,
  type WebhookDelivery,
  type WebhookView,
} from '../lib/webhook-api';

export const WEBHOOK_SECRET_ONCE_COPY = 'This secret will not be shown again. Copy it now and paste it into GitHub.';
export const WEBHOOK_FAILED_COPY = "Couldn't update the webhook. Check your connection and try again.";
export const WEBHOOK_LOAD_FAILED_COPY = "Couldn't load the webhook. Check your connection and try again.";
export const DELIVERIES_EMPTY_COPY = 'No deliveries yet. Pushes from GitHub will appear here.';
export const DELIVERIES_FAILED_COPY = "Couldn't load recent deliveries.";
export const UNKNOWN_OUTCOME_LABEL = 'Unrecognized outcome';
const PAGE_SIZE = 10;

const OUTCOME_LABELS: Readonly<Record<string, string>> = Object.freeze({
  deployed: 'Deployed',
  coalesced: 'Queued behind a running deploy',
  superseded: 'Superseded by a newer push',
  already_deployed: 'Already deployed',
  ping: 'Ping received',
  ignored_event: 'Ignored event',
  ignored_tag: 'Ignored tag',
  ignored_ref: 'Ignored ref',
  ignored_branch: 'Ignored branch',
  ignored_deletion: 'Ignored branch deletion',
  repository_mismatch: 'Repository does not match',
  invalid_payload: 'Invalid payload',
  invalid_sha: 'Invalid commit',
  project_archived: 'Project archived',
  source_not_git: 'Service is not built from Git',
});

export function outcomeLabel(outcome: string): string {
  return Object.hasOwn(OUTCOME_LABELS, outcome) ? (OUTCOME_LABELS[outcome] ?? UNKNOWN_OUTCOME_LABEL) : UNKNOWN_OUTCOME_LABEL;
}

type Confirm = 'rotate' | 'disable' | null;
type Load = 'loading' | 'ready' | 'failed';

export interface WebhookPanelProps {
  readonly projectId: string;
  readonly serviceId: string;
  readonly sourceType: 'git' | 'image';
  /** Test seam for the relative times. */
  readonly now?: Date;
}

function CopyField({ label, value, onCopied }: { label: string; value: string; onCopied: (message: string) => void }) {
  return (
    <div className="flex min-h-11 items-center gap-2">
      <span className="w-20 shrink-0 text-caption text-ink-secondary">{label}</span>
      <code className="min-w-0 flex-1 break-all font-mono text-caption text-ink">{value}</code>
      <Button
        type="button"
        variant="ghost"
        aria-label={`Copy ${label.toLowerCase()}`}
        onClick={() => {
          const clipboard = navigator.clipboard as Clipboard | undefined;
          if (typeof clipboard?.writeText !== 'function') {
            onCopied(`Couldn't copy the ${label.toLowerCase()}. Select it and copy manually.`);
            return;
          }
          clipboard.writeText(value).then(
            () => {
              onCopied(`${label} copied`);
            },
            () => {
              onCopied(`Couldn't copy the ${label.toLowerCase()}. Select it and copy manually.`);
            },
          );
        }}
      >
        Copy
      </Button>
    </div>
  );
}

export function WebhookPanel({ projectId, serviceId, sourceType, now }: WebhookPanelProps) {
  if (sourceType !== 'git') return null;
  return <GitWebhookPanel projectId={projectId} serviceId={serviceId} now={now} />;
}

function GitWebhookPanel({ projectId, serviceId, now }: { readonly projectId: string; readonly serviceId: string; readonly now?: Date | undefined }) {
  const [load, setLoad] = useState<Load>('loading');
  const [view, setView] = useState<WebhookView | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');
  const [deliveries, setDeliveries] = useState<readonly WebhookDelivery[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [deliveriesFailed, setDeliveriesFailed] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      setSecret(null);
    };
  }, []);

  const loadDeliveries = useCallback(
    async (after?: string) => {
      const result = await listWebhookDeliveries(projectId, serviceId, {
        limit: PAGE_SIZE,
        ...(after === undefined ? {} : { cursor: after }),
      });
      if (!mounted.current) return;
      if (!result.ok) {
        if (result.unauthorized) void requireSession();
        setDeliveriesFailed(true);
        return;
      }
      setDeliveriesFailed(false);
      setDeliveries((current) => (after === undefined ? result.data.deliveries : [...current, ...result.data.deliveries]));
      setCursor(result.data.nextCursor);
    },
    [projectId, serviceId],
  );

  useEffect(() => {
    let cancelled = false;
    void getWebhook(projectId, serviceId).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        if (result.unauthorized) void requireSession();
        setLoad('failed');
        return;
      }
      setView(result.data);
      setLoad('ready');
      if (result.data.enabled) void loadDeliveries();
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, serviceId, loadDeliveries]);

  const run = useCallback(
    async (action: () => Promise<WebhookApiResult<unknown>>, apply: (data: unknown) => void) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      setError(null);
      const result = await action();
      inFlight.current = false;
      if (!mounted.current) return;
      setBusy(false);
      if (!result.ok) {
        if (result.unauthorized) void requireSession();
        setError(WEBHOOK_FAILED_COPY);
        return;
      }
      apply(result.data);
    },
    [],
  );

  const onSecretResult = useCallback(
    (data: unknown) => {
      const next = data as { payloadUrl: string; secret: string };
      setView({ enabled: true, payloadUrl: next.payloadUrl });
      setSecret(next.secret);
      setAnnounce('');
      void loadDeliveries();
    },
    [loadDeliveries],
  );

  const onEnable = () => {
    void run(() => enableWebhook(projectId, serviceId), onSecretResult);
  };
  const onConfirm = () => {
    const which = confirm;
    setConfirm(null);
    setSecret(null);
    if (which === 'rotate') {
      void run(() => rotateWebhook(projectId, serviceId), onSecretResult);
    } else if (which === 'disable') {
      void run(
        () => disableWebhook(projectId, serviceId),
        () => {
          setView({ enabled: false, payloadUrl: null });
          setDeliveries([]);
          setCursor(null);
        },
      );
    }
  };

  if (load === 'loading') {
    return (
      <p data-testid="webhook-loading" className="px-4 py-3 text-callout text-ink-secondary">
        Loading webhook…
      </p>
    );
  }
  if (load === 'failed' || view === null) {
    return (
      <p role="alert" data-testid="webhook-load-failed" className="px-4 py-3 text-callout text-status-error-text">
        {WEBHOOK_LOAD_FAILED_COPY}
      </p>
    );
  }

  const payloadUrl = safePayloadUrl(view.payloadUrl);
  const clock = now ?? new Date();

  return (
    <section aria-label="Push webhook" data-testid="webhook-panel" className="flex flex-col gap-4 px-4 py-3">
      <p className="text-callout text-ink-secondary">
        Deploy automatically when you push to the service's branch on GitHub.
      </p>

      {view.enabled ? (
        <div className="flex flex-col gap-1">
          {payloadUrl === null ? (
            <p data-testid="webhook-url-unavailable" className="text-callout text-ink-secondary">
              The payload URL is unavailable. Rotate the secret or disable and enable the webhook again.
            </p>
          ) : (
            <CopyField label="Payload URL" value={payloadUrl} onCopied={setAnnounce} />
          )}
          {secret === null ? null : (
            <div data-testid="webhook-secret" className="flex flex-col gap-1">
              <CopyField label="Secret" value={secret} onCopied={setAnnounce} />
              <p className="text-caption text-ink-secondary" data-testid="webhook-secret-once">
                {WEBHOOK_SECRET_ONCE_COPY}
              </p>
              <div>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setSecret(null);
                  }}
                >
                  Hide secret
                </Button>
              </div>
            </div>
          )}
          <div className="flex gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setConfirm('rotate');
              }}
            >
              Rotate secret
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setConfirm('disable');
              }}
            >
              Disable
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button type="button" variant="primary" disabled={busy} onClick={onEnable}>
            Enable webhook
          </Button>
        </div>
      )}

      <p role="status" aria-live="polite" data-testid="webhook-announce" className="min-h-4 text-caption text-ink-secondary">
        {announce}
      </p>
      {error === null ? null : (
        <p role="alert" data-testid="webhook-error" className="text-caption text-status-error-text">
          {error}
        </p>
      )}

      {view.enabled ? (
        <div className="flex flex-col" data-testid="webhook-deliveries">
          <h3 className="mb-1 text-callout font-medium text-ink">Recent deliveries</h3>
          {deliveriesFailed ? (
            <p role="alert" data-testid="webhook-deliveries-failed" className="text-caption text-status-error-text">
              {DELIVERIES_FAILED_COPY}
            </p>
          ) : deliveries.length === 0 ? (
            <p data-testid="webhook-deliveries-empty" className="text-callout text-ink-secondary">
              {DELIVERIES_EMPTY_COPY}
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-hairline">
              {deliveries.map((row) => (
                <li
                  key={row.id}
                  data-testid={`webhook-delivery-${row.id}`}
                  className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 py-2 text-callout"
                >
                  <span data-testid="delivery-outcome" className="text-ink">
                    {outcomeLabel(row.outcome)}
                  </span>
                  <span data-testid="delivery-sha" className="font-mono text-ink-secondary">
                    {shortSha(row.pushedSha)}
                  </span>
                  <span className="text-caption text-ink-secondary">
                    <RelativeTime value={row.receivedAt} now={clock} />
                  </span>
                  {row.deploymentId === null ? null : (
                    <Link
                      href={deploymentInspectorHref(row.deploymentId)}
                      scroll={false}
                      data-testid="delivery-deployment-link"
                      className="ml-auto text-caption text-accent"
                    >
                      View deployment
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          )}
          {cursor === null ? null : (
            <div className="pt-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  void loadDeliveries(cursor);
                }}
              >
                Load more
              </Button>
            </div>
          )}
        </div>
      ) : null}

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title={confirm === 'rotate' ? 'Rotate the webhook secret?' : 'Disable the webhook?'}
        body={
          confirm === 'rotate'
            ? 'The current secret stops working immediately. Update it in GitHub with the new one or pushes will be rejected.'
            : 'Pushes will no longer deploy this service. You can enable it again later with a new URL and secret.'
        }
        confirmLabel={confirm === 'rotate' ? 'Rotate secret' : 'Disable webhook'}
        onConfirm={onConfirm}
        data-testid="webhook-confirm"
      />
    </section>
  );
}
