import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderUi, screen, userEvent, waitFor } from '@noodara/ui/testing';
import type { WebhookDelivery } from '../lib/webhook-api';
import { DELIVERIES_EMPTY_COPY, UNKNOWN_OUTCOME_LABEL, WEBHOOK_SECRET_ONCE_COPY, WebhookPanel } from './WebhookPanel';

const P = '11111111-1111-4111-8111-111111111111';
const S = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-10-16T12:00:00.000Z');
const URL_OK = `https://n.example.com/webhooks/github/${'h'.repeat(32)}`;
const SECRET = 'f'.repeat(64);
const MARKUP_OUTCOME = ['<', 'img src=x onerror=alert(1)', '>'].join('');
const SHA = '0123456789abcdef0123456789abcdef01234567';
const DEPLOYMENT = '00000000-0000-4000-8000-000000000009';

const api = vi.hoisted(() => ({
  getWebhook: vi.fn(),
  enableWebhook: vi.fn(),
  rotateWebhook: vi.fn(),
  disableWebhook: vi.fn(),
  listWebhookDeliveries: vi.fn(),
}));
vi.mock('../lib/webhook-api', async (importOriginal) => {
  const actual: Record<string, unknown> = await importOriginal();
  return {
    ...actual,
    getWebhook: (...a: unknown[]) => api.getWebhook(...a) as unknown,
    enableWebhook: (...a: unknown[]) => api.enableWebhook(...a) as unknown,
    rotateWebhook: (...a: unknown[]) => api.rotateWebhook(...a) as unknown,
    disableWebhook: (...a: unknown[]) => api.disableWebhook(...a) as unknown,
    listWebhookDeliveries: (...a: unknown[]) => api.listWebhookDeliveries(...a) as unknown,
  };
});
vi.mock('../lib/require-session', () => ({ requireSession: () => undefined }));

function ok(data: unknown) {
  return Promise.resolve({ ok: true, data });
}
const delivery = (n: number, overrides: Partial<WebhookDelivery> = {}): WebhookDelivery => ({
  id: `d${String(n)}`,
  deliveryId: `gh-${String(n)}`,
  event: 'push',
  outcome: 'deployed',
  pushedSha: SHA,
  deploymentId: DEPLOYMENT,
  receivedAt: NOW.toISOString(),
  ...overrides,
});

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  api.getWebhook.mockReturnValue(ok({ enabled: false, payloadUrl: null }));
  api.listWebhookDeliveries.mockReturnValue(ok({ deliveries: [], nextCursor: null }));
  api.enableWebhook.mockReturnValue(ok({ enabled: true, payloadUrl: URL_OK, secret: SECRET }));
  api.rotateWebhook.mockReturnValue(ok({ enabled: true, payloadUrl: URL_OK, secret: 'a'.repeat(64) }));
  api.disableWebhook.mockReturnValue(ok({ enabled: false, payloadUrl: null }));
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

const panel = () => <WebhookPanel projectId={P} serviceId={S} sourceType="git" now={NOW} />;

describe('WebhookPanel', () => {
  it('shows the secret once with a not-shown-again statement, and drops it on unmount', async () => {
    const log = vi.spyOn(console, 'log');
    const user = userEvent.setup();
    const { unmount } = renderUi(panel());
    await user.click(await screen.findByRole('button', { name: 'Enable webhook' }));
    expect(await screen.findByText(SECRET)).toBeTruthy();
    expect(screen.getByText(URL_OK)).toBeTruthy();
    expect(screen.getByText(WEBHOOK_SECRET_ONCE_COPY)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy secret' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy payload url' })).toBeTruthy();
    unmount();
    expect(document.body.textContent).not.toContain(SECRET);
    expect(JSON.stringify(Object.entries(localStorage))).not.toContain(SECRET);
    expect(log).not.toHaveBeenCalled();
  });

  it('announces a successful copy in a live region', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderUi(panel());
    await user.click(await screen.findByRole('button', { name: 'Enable webhook' }));
    await user.click(await screen.findByRole('button', { name: 'Copy secret' }));
    expect(writeText).toHaveBeenCalledWith(SECRET);
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe('Secret copied');
    });
    expect(screen.getByRole('status').textContent).not.toContain(SECRET);
  });

  it('asks for confirmation before rotating and clears the old secret', async () => {
    const user = userEvent.setup();
    renderUi(panel());
    await user.click(await screen.findByRole('button', { name: 'Enable webhook' }));
    await screen.findByText(SECRET);
    await user.click(screen.getByRole('button', { name: 'Rotate secret' }));
    expect(api.rotateWebhook).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    await user.click(Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'Rotate secret') as HTMLElement);
    expect(await screen.findByText('a'.repeat(64))).toBeTruthy();
    expect(api.rotateWebhook).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(SECRET)).toBeNull();
  });

  it('asks for confirmation before disabling, then removes secret and deliveries', async () => {
    api.getWebhook.mockReturnValue(ok({ enabled: true, payloadUrl: URL_OK }));
    api.listWebhookDeliveries.mockReturnValue(ok({ deliveries: [delivery(1)], nextCursor: null }));
    const user = userEvent.setup();
    renderUi(panel());
    await user.click(await screen.findByRole('button', { name: 'Disable' }));
    expect(api.disableWebhook).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    await user.click(Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'Disable webhook') as HTMLElement);
    expect(await screen.findByRole('button', { name: 'Enable webhook' })).toBeTruthy();
    expect(api.disableWebhook).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('webhook-deliveries')).toBeNull();
  });

  it('renders nothing and makes no request for image-source services', () => {
    const { container } = renderUi(<WebhookPanel projectId={P} serviceId={S} sourceType="image" now={NOW} />);
    expect(container.innerHTML).toBe('');
    expect(api.getWebhook).not.toHaveBeenCalled();
  });

  it('lists deliveries as text with a deployment link, tolerating unknown outcomes', async () => {
    api.getWebhook.mockReturnValue(ok({ enabled: true, payloadUrl: URL_OK }));
    api.listWebhookDeliveries.mockReturnValue(
      ok({
        deliveries: [delivery(1), delivery(2, { outcome: MARKUP_OUTCOME, pushedSha: null, deploymentId: null })],
        nextCursor: null,
      }),
    );
    renderUi(panel());
    const first = await screen.findByTestId('webhook-delivery-d1');
    expect(first.textContent).toContain('Deployed');
    expect(first.textContent).toContain(SHA.slice(0, 7));
    expect(first.querySelector('a')?.getAttribute('href')).toBe(`?deployment=${DEPLOYMENT}`);
    const second = screen.getByTestId('webhook-delivery-d2');
    expect(second.textContent).toContain(UNKNOWN_OUTCOME_LABEL);
    expect(second.querySelector('img')).toBeNull();
    expect(second.querySelector('a')).toBeNull();
  });

  it('shows the empty state and refuses a tampered payload URL', async () => {
    api.getWebhook.mockReturnValue(ok({ enabled: true, payloadUrl: 'javascript:alert(1)' }));
    renderUi(panel());
    expect(await screen.findByText(DELIVERIES_EMPTY_COPY)).toBeTruthy();
    expect(screen.getByTestId('webhook-url-unavailable')).toBeTruthy();
    expect(document.body.textContent).not.toContain('javascript:');
  });
});
