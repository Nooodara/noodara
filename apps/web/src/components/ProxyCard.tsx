'use client';

// 24-03 (A1): the server's reverse proxy (22-02) on the server detail screen: status pill, the
// ports it binds, the editable ACME email, install / retry, and remove. Remove is blocked while
// domains route through the proxy: from the `domainsExist` prop, or after the API answers 409
// PROXY_IN_USE (no endpoint exposes a domain count for a server).
import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { Button, ConfirmDialog, Field, Input, TonePill } from '@noodara/ui';
import { requireSession } from '../lib/require-session';
import { domainFailureCopy, proxyFailureCopy, proxyPill } from '../lib/domain-copy';
import {
  installProxy,
  removeProxy,
  setProxyAcmeEmail,
  type ServerApiResult,
  type ServerProxyView,
} from '../lib/server-api';

export const PROXY_REMOVE_BLOCKED_COPY = "Remove this server's domains first.";
export const ACME_EMAIL_INVALID_COPY = 'Enter a valid email address';
export const PROXY_CARD_NOT_INSTALLED_COPY = 'Routes domains to services over HTTPS. Installed with the first domain.';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ProxyCardProps {
  readonly serverId: string;
  readonly proxy: ServerProxyView | null;
  /** True when domains still route through this proxy; remove stays disabled. */
  readonly domainsExist?: boolean;
  /** Called after a successful install, remove or email change. */
  readonly onSettled?: () => void;
}

const NOT_INSTALLED: ServerProxyView = { status: 'NOT_INSTALLED', errorCode: null, acmeEmail: null, installedAt: null };

function failureText(result: ServerApiResult<unknown>): string | null {
  if (result.ok) return null;
  if (result.unauthorized) void requireSession();
  return domainFailureCopy(result);
}

export function ProxyCard({ serverId, proxy: incoming, domainsExist = false, onSettled }: ProxyCardProps) {
  const [proxy, setProxy] = useState<ServerProxyView>(incoming ?? NOT_INSTALLED);
  const [email, setEmail] = useState(incoming?.acmeEmail ?? '');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');
  const [inUse, setInUse] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // A fresh server snapshot (SSE or refetch) replaces the local view.
  useEffect(() => {
    if (incoming !== null) setProxy(incoming);
  }, [incoming]);

  const settle = (result: ServerApiResult<ServerProxyView>, done: string): void => {
    if (!mounted.current) return;
    setBusy(false);
    if (!result.ok) {
      if (result.code === 'PROXY_IN_USE') setInUse(true);
      setError(failureText(result));
      return;
    }
    setError(null);
    setProxy(result.data);
    setAnnounce(done);
    onSettled?.();
  };

  const onInstall = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void installProxy(serverId).then((result) => {
      settle(result, 'Proxy install started');
    });
  };

  const onConfirmRemove = () => {
    setConfirmOpen(false);
    if (busy) return;
    setBusy(true);
    setError(null);
    void removeProxy(serverId).then((result) => {
      settle(result, 'Proxy removed');
    });
  };

  const onSaveEmail = (event: SyntheticEvent) => {
    event.preventDefault();
    const value = email.trim();
    if (!EMAIL_PATTERN.test(value) || value.length > 254) {
      setEmailError(ACME_EMAIL_INVALID_COPY);
      return;
    }
    setEmailError(null);
    if (busy) return;
    setBusy(true);
    void setProxyAcmeEmail(serverId, value).then((result) => {
      settle(result, 'ACME email saved');
    });
  };

  const pill = proxyPill(proxy.status);
  const removable = proxy.status === 'RUNNING' || proxy.status === 'FAILED';
  const removeBlocked = domainsExist || inUse;

  return (
    <section aria-labelledby="proxy-card-title" data-testid="proxy-card" className="flex flex-col gap-3">
      <h3 id="proxy-card-title" className="text-label uppercase text-ink-secondary">
        Reverse proxy
      </h3>
      <div className="flex flex-col gap-4 rounded-lg border border-hairline bg-surface-1 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <TonePill tone={pill.tone} label={pill.label} data-testid="proxy-status-pill" />
          <span className="text-caption text-ink-secondary">
            Ports{' '}
            <span data-testid="proxy-ports" className="font-mono text-ink">
              80, 443
            </span>
          </span>
        </div>

        {proxy.status === 'NOT_INSTALLED' ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-caption text-ink-secondary">{PROXY_CARD_NOT_INSTALLED_COPY}</p>
            <Button type="button" variant="secondary" disabled={busy} onClick={onInstall} data-testid="proxy-install">
              Install proxy
            </Button>
          </div>
        ) : null}

        {proxy.status === 'FAILED' ? (
          <div className="flex flex-wrap items-center gap-2">
            <p data-testid="proxy-failure" className="text-caption text-status-error-text">
              {proxyFailureCopy(proxy.errorCode)}
            </p>
            <Button type="button" variant="secondary" disabled={busy} onClick={onInstall} data-testid="proxy-retry">
              Retry install
            </Button>
          </div>
        ) : null}

        <form noValidate onSubmit={onSaveEmail} className="flex flex-wrap items-end gap-2" data-testid="proxy-acme-form">
          <div className="min-w-0 flex-1">
            <Field
              label="ACME email"
              help="Let's Encrypt sends certificate notices here."
              {...(emailError === null ? {} : { error: emailError })}
            >
              {(control) => (
                <Input
                  {...control}
                  type="email"
                  invalid={emailError !== null}
                  value={email}
                  placeholder="ops@example.com"
                  autoComplete="email"
                  spellCheck={false}
                  maxLength={254}
                  onChange={(event) => {
                    setEmail(event.target.value);
                    if (emailError !== null) setEmailError(null);
                  }}
                  data-testid="proxy-acme-input"
                />
              )}
            </Field>
          </div>
          <Button type="submit" variant="secondary" disabled={busy} data-testid="proxy-acme-save">
            Save
          </Button>
        </form>

        {removable ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={busy || removeBlocked}
              onClick={() => {
                setConfirmOpen(true);
              }}
              data-testid="proxy-remove"
              {...(removeBlocked ? { 'aria-describedby': 'proxy-remove-reason' } : {})}
            >
              Remove proxy
            </Button>
            {removeBlocked ? (
              <p id="proxy-remove-reason" data-testid="proxy-remove-reason" className="text-caption text-ink-secondary">
                {PROXY_REMOVE_BLOCKED_COPY}
              </p>
            ) : null}
          </div>
        ) : null}

        <p role="status" aria-live="polite" className="sr-only">
          {announce}
        </p>
        {error === null ? null : (
          <p role="alert" data-testid="proxy-error" className="text-caption text-status-error-text">
            {error}
          </p>
        )}
      </div>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Remove the proxy?"
        body="The proxy container stops and ports 80 and 443 are freed on this server. You can install it again later."
        confirmLabel="Remove proxy"
        onConfirm={onConfirmRemove}
        data-testid="proxy-remove-confirm"
      />
    </section>
  );
}
