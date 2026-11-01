'use client';

// 24-01: one domain of a service. The row holds the essentials only: hostname, the DNS and
// certificate pills, Check DNS, the per-domain HTTPS redirect switch and Remove. Expiry, the
// failure cause, the route (apply) status and the DNS detail are behind "Details". The open link
// is built only from a hostname that passes the shared validator; everything renders as text.
import { Button, Disclosure, RelativeTime, Switch, TonePill } from '@noodara/ui';
import { DnsInstructions } from './DnsInstructions';
import type { DnsInstructionsView, DomainRowView } from '../lib/domain-api';
import {
  applyStatusCopy,
  certFailureCopy,
  certPill,
  dnsDetail,
  dnsPill,
  safeHostname,
} from '../lib/domain-copy';

export interface DomainRowProps {
  readonly domain: DomainRowView;
  readonly instructions: DnsInstructionsView | null;
  readonly busy: boolean;
  readonly onCheckDns: () => void;
  readonly onToggleRedirect: (next: boolean) => void;
  readonly onRemove: () => void;
  readonly now?: Date;
}

function formatDate(value: string): string | null {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString().slice(0, 10);
}

export function DomainRow({ domain, instructions, busy, onCheckDns, onToggleRedirect, onRemove, now }: DomainRowProps) {
  const dns = dnsPill(domain.dnsStatus);
  const cert = certPill(domain.certStatus);
  const host = safeHostname(domain.hostname);
  const expiry = domain.certNotAfter === null ? null : formatDate(domain.certNotAfter);
  const failure = certFailureCopy(domain.certErrorCode);
  const clock = now ?? new Date();

  return (
    <li data-testid={`domain-row-${domain.id}`} className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span data-testid="domain-hostname" className="min-w-0 break-all font-mono text-callout text-ink">
          {domain.hostname}
        </span>
        {host === null ? null : (
          <a
            href={`https://${host}`}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="domain-open-link"
            className="text-caption text-accent outline-none hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            Open
          </a>
        )}
        <span className="flex items-center gap-1 text-caption text-ink-secondary">
          DNS <TonePill tone={dns.tone} label={dns.label} data-testid="domain-dns-pill" />
        </span>
        <span className="flex items-center gap-1 text-caption text-ink-secondary">
          Certificate <TonePill tone={cert.tone} label={cert.label} data-testid="domain-cert-pill" />
        </span>
        <span className="ml-auto flex items-center gap-2">
          <span className="flex items-center gap-2 text-caption text-ink-secondary">
            Redirect HTTP to HTTPS
            <Switch
              checked={domain.httpsRedirect}
              label={`Redirect HTTP to HTTPS for ${domain.hostname}`}
              disabled={busy}
              onCheckedChange={onToggleRedirect}
              data-testid="domain-redirect-switch"
            />
          </span>
          <Button type="button" variant="ghost" disabled={busy} onClick={onCheckDns} data-testid="domain-check-dns">
            Check DNS
          </Button>
          <Button type="button" variant="destructive" disabled={busy} onClick={onRemove} data-testid="domain-remove">
            Remove
          </Button>
        </span>
      </div>
      {domain.dnsStatus === 'RESOLVES' || instructions === null ? null : <DnsInstructions instructions={instructions} />}
      <Disclosure title="Details" data-testid="domain-details">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 pb-2 text-caption">
          <dt className="text-ink-secondary">DNS</dt>
          <dd data-testid="domain-dns-detail" className="text-ink">
            {dnsDetail(domain.dnsStatus)}
            {domain.dnsCheckedAt === null ? null : (
              <>
                {' '}
                Checked <RelativeTime value={domain.dnsCheckedAt} now={clock} />.
              </>
            )}
          </dd>
          <dt className="text-ink-secondary">Route</dt>
          <dd data-testid="domain-apply-status" className="text-ink">
            {applyStatusCopy(domain.applyStatus)}
          </dd>
          {expiry === null ? null : (
            <>
              <dt className="text-ink-secondary">Expires</dt>
              <dd data-testid="domain-cert-expiry" className="font-mono text-ink">
                {expiry}
              </dd>
            </>
          )}
          {failure === null ? null : (
            <>
              <dt className="text-ink-secondary">Certificate</dt>
              <dd data-testid="domain-cert-failure" className="text-ink">
                {failure}
              </dd>
            </>
          )}
        </dl>
      </Disclosure>
    </li>
  );
}
