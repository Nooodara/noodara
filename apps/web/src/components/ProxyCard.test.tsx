import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderUi, screen, userEvent, within } from '@noodara/ui/testing';
import type { ServerProxyView } from '../lib/server-api';
import { ACME_EMAIL_INVALID_COPY, PROXY_REMOVE_BLOCKED_COPY, ProxyCard } from './ProxyCard';

const SRV = '22222222-2222-4222-8222-222222222222';

const api = vi.hoisted(() => ({
  installProxy: vi.fn(),
  removeProxy: vi.fn(),
  setProxyAcmeEmail: vi.fn(),
}));
vi.mock('../lib/server-api', async (importOriginal) => {
  const actual: Record<string, unknown> = await importOriginal();
  return {
    ...actual,
    installProxy: (...a: unknown[]) => api.installProxy(...a) as unknown,
    removeProxy: (...a: unknown[]) => api.removeProxy(...a) as unknown,
    setProxyAcmeEmail: (...a: unknown[]) => api.setProxyAcmeEmail(...a) as unknown,
  };
});
vi.mock('../lib/require-session', () => ({ requireSession: () => undefined }));

function ok(data: unknown) {
  return Promise.resolve({ ok: true, data });
}
function fail(code: string) {
  return Promise.resolve({ ok: false, code, message: 'raw server text', unauthorized: false });
}

const proxy = (overrides: Partial<ServerProxyView> = {}): ServerProxyView => ({
  status: 'RUNNING',
  errorCode: null,
  acmeEmail: 'ops@example.com',
  installedAt: '2026-10-30T00:00:00.000Z',
  ...overrides,
});

beforeEach(() => {
  api.installProxy.mockReset();
  api.removeProxy.mockReset();
  api.setProxyAcmeEmail.mockReset();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('ProxyCard', () => {
  it.each([
    ['NOT_INSTALLED', 'Not installed'],
    ['INSTALLING', 'Installing'],
    ['RUNNING', 'Running'],
    ['FAILED', 'Failed'],
  ])('shows the %s status as "%s"', (status, label) => {
    renderUi(<ProxyCard serverId={SRV} proxy={proxy({ status })} />);
    expect(within(screen.getByTestId('proxy-card')).getByText('Reverse proxy')).toBeTruthy();
    expect(screen.getByTestId('proxy-status-pill').textContent).toContain(label);
  });

  it('falls back for an unknown status', () => {
    renderUi(<ProxyCard serverId={SRV} proxy={proxy({ status: 'UPGRADING' })} />);
    expect(screen.getByTestId('proxy-status-pill').textContent).not.toContain('UPGRADING');
  });

  it('treats a missing proxy as not installed', () => {
    renderUi(<ProxyCard serverId={SRV} proxy={null} />);
    expect(screen.getByTestId('proxy-status-pill').textContent).toContain('Not installed');
    expect(screen.getByTestId('proxy-install')).toBeTruthy();
  });

  it('lists ports 80 and 443 in mono', () => {
    renderUi(<ProxyCard serverId={SRV} proxy={proxy()} />);
    const ports = screen.getByTestId('proxy-ports');
    expect(ports.textContent).toContain('80');
    expect(ports.textContent).toContain('443');
    expect(ports.className).toContain('font-mono');
  });

  it('installs a not-installed proxy and reports it settled', async () => {
    const user = userEvent.setup();
    const onSettled = vi.fn();
    api.installProxy.mockReturnValue(ok(proxy({ status: 'INSTALLING' })));
    renderUi(<ProxyCard serverId={SRV} proxy={proxy({ status: 'NOT_INSTALLED', acmeEmail: null })} onSettled={onSettled} />);
    await user.click(screen.getByTestId('proxy-install'));
    expect(api.installProxy).toHaveBeenCalledWith(SRV);
    expect((await screen.findByTestId('proxy-status-pill')).textContent).toContain('Installing');
    expect(onSettled).toHaveBeenCalled();
  });

  it('shows recovery copy and retries a failed install', async () => {
    const user = userEvent.setup();
    api.installProxy.mockReturnValue(ok(proxy({ status: 'INSTALLING' })));
    renderUi(<ProxyCard serverId={SRV} proxy={proxy({ status: 'FAILED', errorCode: 'PROXY_PORT_IN_USE' })} />);
    expect(screen.getByTestId('proxy-failure').textContent).toContain('Ports 80 or 443 are already in use');
    await user.click(screen.getByTestId('proxy-retry'));
    expect(api.installProxy).toHaveBeenCalledWith(SRV);
    expect(screen.queryByTestId('proxy-install')).toBeNull();
  });

  it('shows the API failure copy, never the raw message', async () => {
    const user = userEvent.setup();
    api.installProxy.mockReturnValue(fail('PROXY_INSTALL_FAILED'));
    renderUi(<ProxyCard serverId={SRV} proxy={proxy({ status: 'FAILED', errorCode: null })} />);
    await user.click(screen.getByTestId('proxy-retry'));
    const alert = await screen.findByTestId('proxy-error');
    expect(alert.textContent).not.toContain('raw server text');
  });

  it('edits the ACME email', async () => {
    const user = userEvent.setup();
    api.setProxyAcmeEmail.mockReturnValue(ok(proxy({ acmeEmail: 'new@example.com' })));
    renderUi(<ProxyCard serverId={SRV} proxy={proxy()} />);
    const input = screen.getByTestId<HTMLInputElement>('proxy-acme-input');
    expect(input.value).toBe('ops@example.com');
    await user.clear(input);
    await user.type(input, 'new@example.com');
    await user.click(screen.getByTestId('proxy-acme-save'));
    expect(api.setProxyAcmeEmail).toHaveBeenCalledWith(SRV, 'new@example.com');
    expect(await screen.findByText('ACME email saved')).toBeTruthy();
  });

  it('rejects an invalid ACME email without a request', async () => {
    const user = userEvent.setup();
    renderUi(<ProxyCard serverId={SRV} proxy={proxy()} />);
    const input = screen.getByTestId('proxy-acme-input');
    await user.clear(input);
    await user.type(input, 'not-an-email');
    await user.click(screen.getByTestId('proxy-acme-save'));
    expect(screen.getByText(ACME_EMAIL_INVALID_COPY)).toBeTruthy();
    expect(api.setProxyAcmeEmail).not.toHaveBeenCalled();
  });

  it('disables remove with the reason while domains exist', () => {
    renderUi(<ProxyCard serverId={SRV} proxy={proxy()} domainsExist />);
    const remove = screen.getByTestId<HTMLButtonElement>('proxy-remove');
    expect(remove.disabled).toBe(true);
    expect(screen.getByTestId('proxy-remove-reason').textContent).toBe(PROXY_REMOVE_BLOCKED_COPY);
  });

  it('removes the proxy after confirmation', async () => {
    const user = userEvent.setup();
    api.removeProxy.mockReturnValue(ok(proxy({ status: 'NOT_INSTALLED', installedAt: null })));
    renderUi(<ProxyCard serverId={SRV} proxy={proxy()} />);
    await user.click(screen.getByTestId('proxy-remove'));
    expect(api.removeProxy).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    await user.click(within(dialog).getByRole('button', { name: 'Remove proxy' }));
    expect(api.removeProxy).toHaveBeenCalledWith(SRV);
    expect((await screen.findByTestId('proxy-status-pill')).textContent).toContain('Not installed');
  });

  it('disables remove with the reason after a PROXY_IN_USE conflict', async () => {
    const user = userEvent.setup();
    api.removeProxy.mockReturnValue(fail('PROXY_IN_USE'));
    renderUi(<ProxyCard serverId={SRV} proxy={proxy()} />);
    await user.click(screen.getByTestId('proxy-remove'));
    const dialog = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    await user.click(within(dialog).getByRole('button', { name: 'Remove proxy' }));
    expect((await screen.findByTestId('proxy-remove-reason')).textContent).toBe(PROXY_REMOVE_BLOCKED_COPY);
    expect(screen.getByTestId<HTMLButtonElement>('proxy-remove').disabled).toBe(true);
  });

  it('offers no remove while not installed', () => {
    renderUi(<ProxyCard serverId={SRV} proxy={proxy({ status: 'NOT_INSTALLED' })} />);
    expect(screen.queryByTestId('proxy-remove')).toBeNull();
  });
});
