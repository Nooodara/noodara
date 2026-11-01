import { describe, expect, it, vi } from 'vitest';
import { renderUi, screen, userEvent } from '@noodara/ui/testing';
import type { DomainRowView } from '../lib/domain-api';
import { DomainRow } from './DomainRow';

const NOW = new Date('2026-10-30T12:00:00.000Z');
const MARKUP = ['<', 'img src=x onerror=alert(1)', '>'].join('');

function domain(overrides: Partial<DomainRowView> = {}): DomainRowView {
  return {
    id: 'd1',
    hostname: 'app.example.com',
    httpsRedirect: true,
    certStatus: 'ISSUED',
    certNotAfter: '2027-01-15T00:00:00.000Z',
    certErrorCode: null,
    dnsStatus: 'RESOLVES',
    dnsCheckedAt: '2026-10-30T11:00:00.000Z',
    applyStatus: 'APPLIED',
    ...overrides,
  };
}

function renderRow(row: DomainRowView, handlers: Partial<{ onCheckDns: () => void; onToggleRedirect: (n: boolean) => void; onRemove: () => void }> = {}) {
  return renderUi(
    <ul>
      <DomainRow
        domain={row}
        instructions={{ hostname: row.hostname, records: [{ type: 'A', name: row.hostname, value: '203.0.113.7' }], cnameAlternative: null }}
        busy={false}
        onCheckDns={handlers.onCheckDns ?? (() => undefined)}
        onToggleRedirect={handlers.onToggleRedirect ?? (() => undefined)}
        onRemove={handlers.onRemove ?? (() => undefined)}
        now={NOW}
      />
    </ul>,
  );
}

describe('DomainRow', () => {
  it('shows the hostname and the DNS and certificate pills with semantic tones', () => {
    renderRow(domain());
    expect(screen.getByTestId('domain-hostname')).toHaveTextContent('app.example.com');
    expect(screen.getByTestId('domain-dns-pill')).toHaveTextContent('Resolves');
    expect(screen.getByTestId('domain-dns-pill')).toHaveAttribute('data-tone', 'ok');
    expect(screen.getByTestId('domain-cert-pill')).toHaveTextContent('Issued');
    expect(screen.getByTestId('domain-cert-pill')).toHaveAttribute('data-tone', 'ok');
  });

  it('shows the DNS instructions until DNS resolves', () => {
    const { unmount } = renderRow(domain({ dnsStatus: 'MISMATCH' }));
    expect(screen.getByTestId('dns-instructions')).toBeInTheDocument();
    expect(screen.getByTestId('domain-dns-pill')).toHaveAttribute('data-tone', 'error');
    unmount();
    renderRow(domain());
    expect(screen.queryByTestId('dns-instructions')).toBeNull();
  });

  it('keeps expiry, failure cause and apply status out of the row until Details opens', async () => {
    renderRow(domain({ certStatus: 'FAILED', certErrorCode: 'CERT_DNS_MISMATCH', applyStatus: 'FAILED' }));
    expect(screen.queryByTestId('domain-cert-expiry')).toBeNull();
    expect(screen.queryByTestId('domain-cert-failure')).toBeNull();
    expect(screen.queryByTestId('domain-apply-status')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByTestId('domain-cert-expiry')).toHaveTextContent('2027-01-15');
    expect(screen.getByTestId('domain-cert-failure')).toHaveTextContent(/does not point at this server/);
    expect(screen.getByTestId('domain-cert-failure')).not.toHaveTextContent('CERT_DNS_MISMATCH');
    expect(screen.getByTestId('domain-apply-status')).toHaveTextContent(/could not be applied/);
    expect(screen.getByTestId('domain-dns-detail')).toHaveTextContent(/Checked/);
  });

  it('renders a fallback pill for unknown statuses, never the raw value', () => {
    renderRow(domain({ certStatus: 'QUANTUM', dnsStatus: 'SIDEWAYS' }));
    expect(screen.getByTestId('domain-cert-pill')).toHaveTextContent('Unknown');
    expect(screen.getByTestId('domain-dns-pill')).toHaveTextContent('Unknown');
    expect(document.body).not.toHaveTextContent('QUANTUM');
    expect(document.body).not.toHaveTextContent('SIDEWAYS');
  });

  it('opens the validated hostname over https with rel=noopener', () => {
    renderRow(domain());
    const link = screen.getByTestId('domain-open-link');
    expect(link).toHaveAttribute('href', 'https://app.example.com');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('renders a tampered hostname as text and offers no link', () => {
    const { container } = renderRow(domain({ hostname: MARKUP }));
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByTestId('domain-hostname')).toHaveTextContent(MARKUP);
    expect(screen.queryByTestId('domain-open-link')).toBeNull();
  });

  it('wires Check DNS, the redirect switch and Remove', async () => {
    const onCheckDns = vi.fn();
    const onToggleRedirect = vi.fn();
    const onRemove = vi.fn();
    renderRow(domain(), { onCheckDns, onToggleRedirect, onRemove });
    await userEvent.click(screen.getByRole('button', { name: 'Check DNS' }));
    await userEvent.click(screen.getByRole('switch', { name: 'Redirect HTTP to HTTPS for app.example.com' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onCheckDns).toHaveBeenCalledOnce();
    expect(onToggleRedirect).toHaveBeenCalledWith(false);
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it('hides an unparseable expiry', async () => {
    renderRow(domain({ certNotAfter: 'not-a-date' }));
    await userEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.queryByTestId('domain-cert-expiry')).toBeNull();
  });
});
