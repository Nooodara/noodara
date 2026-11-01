'use client';

// 24-01: a service's domains. Add is one field checked client-side with the shared hostname
// validator (the API's own error names); a success refetches the list so the new domain's DNS
// instructions come with it. Each row (DomainRow) carries the DNS and certificate pills, Check
// DNS, the HTTPS redirect switch and Remove (confirmed by hostname). The panel also states that
// HTTPS is served by the server proxy and shows its installing or failed state with a retry.
// Failures render fixed copy (domainFailureCopy), never a raw code or server text.
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Button, ConfirmDialog, Field, Input, TonePill } from '@noodara/ui';
import { DomainRow } from './DomainRow';
import { requireSession } from '../lib/require-session';
import {
  addDomain,
  checkDomainDns,
  listDomains,
  removeDomain,
  retryProxyInstall,
  setHttpsRedirect,
  type DnsInstructionsView,
  type DomainApiResult,
  type DomainRowView,
  type ProxyState,
} from '../lib/domain-api';
import {
  checkHostnameInput,
  domainFailureCopy,
  PROXY_SERVES_HTTPS_COPY,
  proxyFailureCopy,
  proxyPill,
} from '../lib/domain-copy';

export const DOMAINS_LOAD_FAILED_COPY = "Couldn't load the domains. Check your connection and try again.";
export const DOMAINS_EMPTY_COPY = 'No domains yet. Add one to serve this service over HTTPS.';
export const PROXY_INSTALLING_COPY = 'Installing the proxy on this server. Domains go live once it is running.';
export const PROXY_NOT_INSTALLED_COPY = 'The proxy is installed on this server when you add the first domain.';

type Load = 'loading' | 'ready' | 'failed';

export interface DomainsPanelProps {
  readonly projectId: string;
  readonly serviceId: string;
  readonly serverId: string;
  /** The server's proxy state (from its server view), or null when unknown. */
  readonly proxy: ProxyState | null;
  /** Test seam for the relative times. */
  readonly now?: Date;
}

function failureText(result: DomainApiResult<unknown>): string | null {
  if (result.ok) return null;
  if (result.unauthorized) void requireSession();
  return domainFailureCopy(result);
}

export function DomainsPanel({ projectId, serviceId, serverId, proxy: initialProxy, now }: DomainsPanelProps) {
  const [load, setLoad] = useState<Load>('loading');
  const [items, setItems] = useState<readonly DomainRowView[]>([]);
  const [instructions, setInstructions] = useState<readonly DnsInstructionsView[]>([]);
  const [hostname, setHostname] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');
  const [confirm, setConfirm] = useState<DomainRowView | null>(null);
  const [proxy, setProxy] = useState<ProxyState | null>(initialProxy);
  const [retrying, setRetrying] = useState(false);
  const mounted = useRef(true);

  const initialStatus = initialProxy?.status ?? null;
  const initialErrorCode = initialProxy?.errorCode ?? null;
  useEffect(() => {
    setProxy(initialStatus === null ? null : { status: initialStatus, errorCode: initialErrorCode });
  }, [initialStatus, initialErrorCode]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const result = await listDomains(projectId, serviceId);
    if (!mounted.current) return;
    if (!result.ok) {
      if (result.unauthorized) void requireSession();
      setLoad((prev) => (prev === 'ready' ? prev : 'failed'));
      return;
    }
    setItems(result.data.items);
    setInstructions(result.data.dnsInstructions);
    setLoad('ready');
  }, [projectId, serviceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const replaceRow = (row: DomainRowView) => {
    setItems((current) => current.map((entry) => (entry.id === row.id ? row : entry)));
  };

  const withBusy = async (id: string, action: () => Promise<void>) => {
    if (busyIds.has(id)) return;
    setBusyIds((current) => new Set(current).add(id));
    setError(null);
    await action();
    if (!mounted.current) return;
    setBusyIds((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (adding) return;
    const checked = checkHostnameInput(hostname);
    if (!checked.ok) {
      setInputError(checked.message);
      return;
    }
    setInputError(null);
    setError(null);
    setAdding(true);
    void addDomain(projectId, serviceId, checked.hostname).then(async (result) => {
      if (!mounted.current) return;
      setAdding(false);
      if (!result.ok) {
        const text = failureText(result);
        if (result.reason === undefined) setError(text);
        else setInputError(text);
        return;
      }
      setHostname('');
      setItems((current) => [...current.filter((entry) => entry.id !== result.data.id), result.data]);
      setAnnounce(`${result.data.hostname} added`);
      await refresh();
    });
  };

  const onCheckDns = (domain: DomainRowView) => {
    void withBusy(domain.id, async () => {
      const result = await checkDomainDns(projectId, serviceId, domain.id);
      if (!mounted.current) return;
      if (!result.ok) {
        setError(failureText(result));
        return;
      }
      replaceRow(result.data);
      setAnnounce(`DNS checked for ${result.data.hostname}`);
    });
  };

  const onToggleRedirect = (domain: DomainRowView, next: boolean) => {
    void withBusy(domain.id, async () => {
      const result = await setHttpsRedirect(projectId, serviceId, domain.id, next);
      if (!mounted.current) return;
      if (!result.ok) {
        setError(failureText(result));
        return;
      }
      replaceRow(result.data);
    });
  };

  const onConfirmRemove = () => {
    const domain = confirm;
    setConfirm(null);
    if (domain === null) return;
    void withBusy(domain.id, async () => {
      const result = await removeDomain(projectId, serviceId, domain.id);
      if (!mounted.current) return;
      if (!result.ok) {
        setError(failureText(result));
        return;
      }
      setItems((current) => current.filter((entry) => entry.id !== domain.id));
      setAnnounce(`${domain.hostname} removed`);
    });
  };

  const onRetryProxy = () => {
    if (retrying) return;
    setRetrying(true);
    setError(null);
    void retryProxyInstall(serverId).then((result) => {
      if (!mounted.current) return;
      setRetrying(false);
      if (!result.ok) {
        setError(failureText(result));
        return;
      }
      setProxy(result.data);
    });
  };

  const pill = proxy === null ? null : proxyPill(proxy.status);

  return (
    <section aria-label="Domains" data-testid="domains-panel" className="flex flex-col gap-4">
      <div data-testid="domains-proxy" className="flex flex-col gap-2">
        <p className="flex flex-wrap items-center gap-2 text-callout text-ink-secondary">
          {PROXY_SERVES_HTTPS_COPY}
          {pill === null ? null : (
            <span className="flex items-center gap-1 text-caption">
              Proxy <TonePill tone={pill.tone} label={pill.label} data-testid="domains-proxy-pill" />
            </span>
          )}
        </p>
        {proxy?.status === 'INSTALLING' ? (
          <p data-testid="domains-proxy-installing" className="text-caption text-ink-secondary">
            {PROXY_INSTALLING_COPY}
          </p>
        ) : null}
        {proxy?.status === 'NOT_INSTALLED' ? (
          <p data-testid="domains-proxy-not-installed" className="text-caption text-ink-secondary">
            {PROXY_NOT_INSTALLED_COPY}
          </p>
        ) : null}
        {proxy?.status === 'FAILED' ? (
          <div data-testid="domains-proxy-failed" className="flex flex-wrap items-center gap-2">
            <p className="text-caption text-status-error-text">{proxyFailureCopy(proxy.errorCode)}</p>
            <Button type="button" variant="secondary" disabled={retrying} onClick={onRetryProxy} data-testid="domains-proxy-retry">
              Retry proxy install
            </Button>
          </div>
        ) : null}
      </div>

      <form noValidate onSubmit={onSubmit} className="flex flex-wrap items-end gap-2" data-testid="domain-add-form">
        <div className="min-w-0 flex-1">
          <Field label="Domain" {...(inputError === null ? {} : { error: inputError })}>
            {(control) => (
              <Input
                {...control}
                mono
                invalid={inputError !== null}
                value={hostname}
                placeholder="app.example.com"
                autoComplete="off"
                spellCheck={false}
                maxLength={253}
                onChange={(event) => {
                  setHostname(event.target.value);
                  if (inputError !== null) setInputError(null);
                }}
                data-testid="domain-add-input"
              />
            )}
          </Field>
        </div>
        <Button type="submit" variant="primary" disabled={adding} data-testid="domain-add-submit">
          Add domain
        </Button>
      </form>

      <p role="status" aria-live="polite" data-testid="domains-announce" className="sr-only">
        {announce}
      </p>
      {error === null ? null : (
        <p role="alert" data-testid="domains-error" className="text-caption text-status-error-text">
          {error}
        </p>
      )}

      {load === 'loading' ? (
        <p data-testid="domains-loading" className="text-callout text-ink-secondary">
          Loading domains…
        </p>
      ) : load === 'failed' ? (
        <p role="alert" data-testid="domains-load-failed" className="text-callout text-status-error-text">
          {DOMAINS_LOAD_FAILED_COPY}
        </p>
      ) : items.length === 0 ? (
        <p data-testid="domains-empty" className="text-callout text-ink-secondary">
          {DOMAINS_EMPTY_COPY}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-hairline">
          {items.map((domain) => (
            <DomainRow
              key={domain.id}
              domain={domain}
              instructions={instructions.find((entry) => entry.hostname === domain.hostname) ?? null}
              busy={busyIds.has(domain.id)}
              onCheckDns={() => {
                onCheckDns(domain);
              }}
              onToggleRedirect={(next) => {
                onToggleRedirect(domain, next);
              }}
              onRemove={() => {
                setConfirm(domain);
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
        title={confirm === null ? 'Remove domain?' : `Remove ${confirm.hostname}?`}
        body={
          confirm === null
            ? ''
            : `${confirm.hostname} stops routing to this service and its certificate is no longer renewed. You can add it again later.`
        }
        confirmLabel="Remove domain"
        onConfirm={onConfirmRemove}
        data-testid="domain-remove-confirm"
      />
    </section>
  );
}
