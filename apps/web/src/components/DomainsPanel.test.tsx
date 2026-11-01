import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderUi, screen, userEvent, waitFor, within } from '@noodara/ui/testing';
import type { DnsInstructionsView, DomainRowView } from '../lib/domain-api';
import {
  DOMAIN_GENERIC_FAILURE_COPY,
  HOSTNAME_ERROR_COPY,
  PROXY_SERVES_HTTPS_COPY,
} from '../lib/domain-copy';
import {
  DOMAINS_EMPTY_COPY,
  DOMAINS_LOAD_FAILED_COPY,
  DomainsPanel,
  PROXY_INSTALLING_COPY,
  PROXY_NOT_INSTALLED_COPY,
} from './DomainsPanel';

const P = '11111111-1111-4111-8111-111111111111';
const S = '44444444-4444-4444-8444-444444444444';
const SRV = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-11-01T12:00:00.000Z');

const api = vi.hoisted(() => ({
  listDomains: vi.fn(),
  addDomain: vi.fn(),
  setHttpsRedirect: vi.fn(),
  checkDomainDns: vi.fn(),
  removeDomain: vi.fn(),
  retryProxyInstall: vi.fn(),
}));
vi.mock('../lib/domain-api', async (importOriginal) => {
  const actual: Record<string, unknown> = await importOriginal();
  return {
    ...actual,
    listDomains: (...a: unknown[]) => api.listDomains(...a) as unknown,
    addDomain: (...a: unknown[]) => api.addDomain(...a) as unknown,
    setHttpsRedirect: (...a: unknown[]) => api.setHttpsRedirect(...a) as unknown,
    checkDomainDns: (...a: unknown[]) => api.checkDomainDns(...a) as unknown,
    removeDomain: (...a: unknown[]) => api.removeDomain(...a) as unknown,
    retryProxyInstall: (...a: unknown[]) => api.retryProxyInstall(...a) as unknown,
  };
});
vi.mock('../lib/require-session', () => ({ requireSession: () => undefined }));

function ok(data: unknown) {
  return Promise.resolve({ ok: true, data });
}
function fail(code: string, reason?: string) {
  return Promise.resolve({
    ok: false,
    code,
    message: 'raw server text',
    unauthorized: false,
    ...(reason === undefined ? {} : { reason }),
  });
}

const domain = (id: string, hostname: string, overrides: Partial<DomainRowView> = {}): DomainRowView => ({
  id,
  hostname,
  httpsRedirect: true,
  certStatus: 'NONE',
  certNotAfter: null,
  certErrorCode: null,
  dnsStatus: null,
  dnsCheckedAt: null,
  applyStatus: 'APPLIED',
  ...overrides,
});
const instructionsFor = (hostname: string): DnsInstructionsView => ({
  hostname,
  records: [{ type: 'A', name: hostname, value: '203.0.113.10' }],
  cnameAlternative: null,
});
const list = (items: DomainRowView[]) =>
  ok({ items, dnsInstructions: items.map((entry) => instructionsFor(entry.hostname)) });

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  api.listDomains.mockReturnValue(list([]));
});

afterEach(() => {
  vi.restoreAllMocks();
});

const panel = (proxy: { status: string; errorCode: string | null } | null = { status: 'RUNNING', errorCode: null }) => (
  <DomainsPanel projectId={P} serviceId={S} serverId={SRV} proxy={proxy} now={NOW} />
);

describe('DomainsPanel', () => {
  it('validates the hostname client-side with the shared validator copy and never calls the API', async () => {
    const user = userEvent.setup();
    renderUi(panel());
    expect(await screen.findByText(DOMAINS_EMPTY_COPY)).toBeTruthy();
    await user.type(screen.getByTestId('domain-add-input'), 'https://app.example.com');
    await user.click(screen.getByTestId('domain-add-submit'));
    expect(await screen.findByText(HOSTNAME_ERROR_COPY.HOSTNAME_CONTAINS_SCHEME)).toBeTruthy();
    await user.clear(screen.getByTestId('domain-add-input'));
    await user.click(screen.getByTestId('domain-add-submit'));
    expect(await screen.findByText(HOSTNAME_ERROR_COPY.HOSTNAME_REQUIRED)).toBeTruthy();
    expect(api.addDomain).not.toHaveBeenCalled();
  });

  it('adds a domain and shows its DNS instructions and pills after the refetch', async () => {
    const user = userEvent.setup();
    const added = domain('d1', 'app.example.com');
    api.addDomain.mockReturnValue(ok(added));
    renderUi(panel());
    await screen.findByText(DOMAINS_EMPTY_COPY);
    api.listDomains.mockReturnValue(list([added]));
    await user.type(screen.getByTestId('domain-add-input'), 'App.Example.com');
    await user.click(screen.getByTestId('domain-add-submit'));
    expect(api.addDomain).toHaveBeenCalledWith(P, S, 'app.example.com');
    const row = await screen.findByTestId('domain-row-d1');
    const instructions = await within(row).findByTestId('dns-instructions');
    expect(within(instructions).getByTestId('dns-record-type').textContent).toBe('A');
    expect(within(instructions).getByTestId('dns-record-value').textContent).toBe('203.0.113.10');
    expect(within(row).getByTestId('domain-dns-pill')).toBeTruthy();
    expect(within(row).getByTestId('domain-cert-pill')).toBeTruthy();
    expect(screen.getByTestId<HTMLInputElement>('domain-add-input').value).toBe('');
    expect(api.listDomains).toHaveBeenCalledTimes(2);
  });

  it('shows an API hostname reason inline and any other failure as fixed copy, never the raw code', async () => {
    const user = userEvent.setup();
    api.addDomain.mockReturnValueOnce(fail('VALIDATION_FAILED', 'HOSTNAME_SPECIAL_USE_TLD'));
    renderUi(panel());
    await screen.findByText(DOMAINS_EMPTY_COPY);
    await user.type(screen.getByTestId('domain-add-input'), 'app.example.com');
    await user.click(screen.getByTestId('domain-add-submit'));
    expect(await screen.findByText(HOSTNAME_ERROR_COPY.HOSTNAME_SPECIAL_USE_TLD)).toBeTruthy();

    api.addDomain.mockReturnValueOnce(fail('INTERNAL_ERROR'));
    await user.click(screen.getByTestId('domain-add-submit'));
    expect((await screen.findByTestId('domains-error')).textContent).toBe(DOMAIN_GENERIC_FAILURE_COPY);
    const text = document.body.textContent;
    expect(text).not.toContain('INTERNAL_ERROR');
    expect(text).not.toContain('raw server text');
  });

  it('re-runs the DNS check for that domain and shows the new pill', async () => {
    const user = userEvent.setup();
    api.listDomains.mockReturnValue(list([domain('d1', 'app.example.com')]));
    api.checkDomainDns.mockReturnValue(
      ok(domain('d1', 'app.example.com', { dnsStatus: 'MISMATCH', dnsCheckedAt: NOW.toISOString() })),
    );
    renderUi(panel());
    const row = await screen.findByTestId('domain-row-d1');
    const before = within(row).getByTestId('domain-dns-pill').textContent;
    await user.click(within(row).getByTestId('domain-check-dns'));
    expect(api.checkDomainDns).toHaveBeenCalledWith(P, S, 'd1');
    await waitFor(() => {
      expect(within(row).getByTestId('domain-dns-pill').textContent).not.toBe(before);
    });
  });

  it('toggles the HTTPS redirect per domain', async () => {
    const user = userEvent.setup();
    api.listDomains.mockReturnValue(list([domain('d1', 'a.example.com'), domain('d2', 'b.example.com')]));
    api.setHttpsRedirect.mockReturnValue(ok(domain('d2', 'b.example.com', { httpsRedirect: false })));
    renderUi(panel());
    const second = await screen.findByTestId('domain-row-d2');
    await user.click(within(second).getByRole('switch', { name: 'Redirect HTTP to HTTPS for b.example.com' }));
    expect(api.setHttpsRedirect).toHaveBeenCalledWith(P, S, 'd2', false);
    await waitFor(() => {
      expect(within(second).getByRole('switch').getAttribute('aria-checked')).toBe('false');
    });
    const first = screen.getByTestId('domain-row-d1');
    expect(within(first).getByRole('switch').getAttribute('aria-checked')).toBe('true');
  });

  it('asks for confirmation naming the hostname before removing', async () => {
    const user = userEvent.setup();
    api.listDomains.mockReturnValue(list([domain('d1', 'app.example.com')]));
    api.removeDomain.mockReturnValue(ok(null));
    renderUi(panel());
    const row = await screen.findByTestId('domain-row-d1');
    await user.click(within(row).getByTestId('domain-remove'));
    expect(api.removeDomain).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    expect(within(dialog).getByText('Remove app.example.com?')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Remove domain' }));
    expect(api.removeDomain).toHaveBeenCalledWith(P, S, 'd1');
    expect(await screen.findByText(DOMAINS_EMPTY_COPY)).toBeTruthy();
  });

  it('states that HTTPS is served by the server proxy and explains the not-installed state', async () => {
    renderUi(panel({ status: 'NOT_INSTALLED', errorCode: null }));
    expect(screen.getByText(PROXY_SERVES_HTTPS_COPY)).toBeTruthy();
    expect(screen.getByText(PROXY_NOT_INSTALLED_COPY)).toBeTruthy();
    await screen.findByText(DOMAINS_EMPTY_COPY);
  });

  it('shows the installing proxy state', async () => {
    renderUi(panel({ status: 'INSTALLING', errorCode: null }));
    expect(screen.getByText(PROXY_INSTALLING_COPY)).toBeTruthy();
    expect(screen.queryByTestId('domains-proxy-retry')).toBeNull();
    await screen.findByText(DOMAINS_EMPTY_COPY);
  });

  it('shows a failed proxy with a retry that reinstalls it', async () => {
    const user = userEvent.setup();
    api.retryProxyInstall.mockReturnValue(ok({ status: 'INSTALLING', errorCode: null }));
    renderUi(panel({ status: 'FAILED', errorCode: 'PROXY_PORT_IN_USE' }));
    await screen.findByText(DOMAINS_EMPTY_COPY);
    expect(screen.getByTestId('domains-proxy-failed').textContent).not.toContain('PROXY_PORT_IN_USE');
    await user.click(screen.getByTestId('domains-proxy-retry'));
    expect(api.retryProxyInstall).toHaveBeenCalledWith(SRV);
    expect(await screen.findByText(PROXY_INSTALLING_COPY)).toBeTruthy();
  });

  it('renders a fallback pill for an unknown proxy status', async () => {
    renderUi(panel({ status: 'SOMETHING_NEW', errorCode: null }));
    expect(screen.getByTestId('domains-proxy-pill').textContent).toContain('Unknown');
    await screen.findByText(DOMAINS_EMPTY_COPY);
  });

  it('shows fixed copy when the list fails to load', async () => {
    api.listDomains.mockReturnValue(fail('INTERNAL_ERROR'));
    renderUi(panel());
    expect(await screen.findByText(DOMAINS_LOAD_FAILED_COPY)).toBeTruthy();
  });

  it('renders markup in a hostname as text only', async () => {
    const markup = ['<', 'img src=x onerror=alert(1)', '>'].join('');
    api.listDomains.mockReturnValue(ok({ items: [domain('d1', markup)], dnsInstructions: [] }));
    renderUi(panel());
    const row = await screen.findByTestId('domain-row-d1');
    expect(within(row).getByTestId('domain-hostname').textContent).toBe(markup);
    expect(row.querySelector('img')).toBeNull();
    expect(within(row).queryByTestId('domain-open-link')).toBeNull();
  });
});
