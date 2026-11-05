import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { renderUi, screen, userEvent, waitFor } from '@noodara/ui/testing';
import type { LogEntryView, LogSource } from '../../lib/api/logs-api';
import { LOGS_COPY, ServiceLogsPanel } from './ServiceLogsPanel';

const PRJ = '22222222-2222-4222-8222-222222222222';
const SVC = '33333333-3333-4333-8333-333333333333';

const api = vi.hoisted(() => ({ getServiceLogs: vi.fn(), followServiceLogs: vi.fn() }));
vi.mock('../../lib/api/logs-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/logs-api')>()),
  getServiceLogs: (...a: unknown[]) => api.getServiceLogs(...a) as unknown,
  followServiceLogs: (...a: unknown[]) => api.followServiceLogs(...a) as unknown,
}));
vi.mock('../../lib/require-session', () => ({ requireSession: () => undefined }));

function entry(text: string, source: LogSource = 'runtime', extra: Partial<LogEntryView> = {}): LogEntryView {
  return { source, timestamp: '2026-11-05T10:00:00.000Z', level: 'info', stream: null, text, truncated: false, ...extra };
}

function page(entries: readonly LogEntryView[], extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    data: { entries, since: 's', until: 'u', nextUntil: null, unavailableSources: [], nextCursor: null, truncated: false, ...extra },
  };
}

function render() {
  return renderUi(<ServiceLogsPanel projectId={PRJ} serviceId={SVC} />);
}

describe('ServiceLogsPanel', () => {
  beforeEach(() => {
    api.getServiceLogs.mockReset();
    api.followServiceLogs.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows every line with its mono timestamp and source; all four source chips start on', async () => {
    api.getServiceLogs.mockResolvedValue(page([entry('second', 'build'), entry('first', 'activity')]));
    render();
    const lines = await screen.findAllByTestId('log-line');
    expect(lines.map((l) => l.querySelector('[data-testid="log-line-source"]')?.textContent)).toEqual(['Activity', 'Build']);
    expect(lines[0]?.querySelector('time')).toHaveAttribute('dateTime', '2026-11-05T10:00:00.000Z');
    for (const source of ['build', 'deploy', 'runtime', 'activity']) {
      expect(screen.getByTestId(`log-source-${source}`)).toHaveAttribute('aria-pressed', 'true');
    }
    expect(screen.getByTestId('log-list').className).toContain('font-mono');
  });

  it('renders hostile text inert: no element, no anchor, the text verbatim', async () => {
    const hostile = '<img src=x onerror="alert(1)"> \u001b[31mred\u001b[0m javascript:alert(1)';
    api.getServiceLogs.mockResolvedValue(page([entry(hostile)]));
    render();
    const text = await screen.findByTestId('log-line-text');
    expect(text.textContent).toBe(hostile);
    expect(text.children).toHaveLength(0);
    expect(screen.getByTestId('service-logs-view').querySelector('img, a')).toBeNull();
  });

  it('virtualizes 10k lines', async () => {
    const many = Array.from({ length: 10_000 }, (_, i) => entry(`line ${String(i)}`));
    api.getServiceLogs.mockResolvedValue(page(many));
    render();
    await screen.findAllByTestId('log-line');
    expect(screen.getByTestId('log-list')).toHaveAttribute('data-count', '10000');
    expect(screen.getAllByTestId('log-line').length).toBeLessThan(100);
  });

  it('sends source, level, window and search to the API; the search is capped', async () => {
    api.getServiceLogs.mockResolvedValue(page([]));
    const user = userEvent.setup();
    render();
    await screen.findByTestId('log-empty');
    expect(screen.getByTestId('log-empty')).toHaveTextContent(LOGS_COPY.empty);

    await user.click(screen.getByTestId('log-source-runtime'));
    await waitFor(() => {
      expect(api.getServiceLogs).toHaveBeenLastCalledWith(
        PRJ,
        SVC,
        expect.objectContaining({ sources: ['build', 'deploy', 'activity'] }),
        expect.any(AbortSignal),
      );
    });
    await user.click(screen.getByRole('radio', { name: 'Error' }));
    await user.click(screen.getByRole('radio', { name: '1h' }));
    await waitFor(() => {
      expect(api.getServiceLogs).toHaveBeenLastCalledWith(PRJ, SVC, expect.objectContaining({ level: 'error' }), expect.any(AbortSignal));
    });
    const call = api.getServiceLogs.mock.lastCall as [string, string, { since: string }];
    expect(Date.now() - Date.parse(call[2].since)).toBeGreaterThanOrEqual(60 * 60_000 - 5_000);

    const search = screen.getByTestId('log-search');
    expect(search).toHaveAttribute('maxLength', '200');
    await user.type(search, 'boom');
    await waitFor(() => {
      expect(api.getServiceLogs).toHaveBeenLastCalledWith(PRJ, SVC, expect.objectContaining({ search: 'boom' }), expect.any(AbortSignal));
    });
    expect(screen.getByTestId('log-empty')).toHaveTextContent(LOGS_COPY.emptyFiltered);
  });

  it('never turns off the last source', async () => {
    api.getServiceLogs.mockResolvedValue(page([]));
    const user = userEvent.setup();
    render();
    for (const s of ['build', 'deploy', 'runtime', 'activity']) await user.click(screen.getByTestId(`log-source-${s}`));
    expect(screen.getByTestId('log-source-activity')).toHaveAttribute('aria-pressed', 'true');
  });

  it('explains truncation, a truncated line and unavailable sources', async () => {
    api.getServiceLogs.mockResolvedValue(
      page([entry('long', 'runtime', { truncated: true })], { truncated: true, unavailableSources: ['runtime'] }),
    );
    render();
    expect(await screen.findByTestId('log-truncated')).toHaveTextContent(LOGS_COPY.truncated);
    expect(screen.getByTestId('log-unavailable')).toHaveTextContent(LOGS_COPY.unavailable(['runtime']));
    expect(screen.getByTestId('log-line-truncated')).toHaveTextContent(LOGS_COPY.lineTruncated);
  });

  it('explains when every selected source is unavailable, and a load failure', async () => {
    api.getServiceLogs.mockResolvedValueOnce({ ok: false, code: 'LOG_SOURCE_UNAVAILABLE', message: 'm', unauthorized: false });
    const { unmount } = render();
    expect(await screen.findByTestId('log-all-unavailable')).toHaveTextContent(LOGS_COPY.allUnavailable);
    unmount();
    api.getServiceLogs.mockResolvedValueOnce({ ok: false, code: 'INTERNAL_ERROR', message: 'm', unauthorized: false });
    render();
    expect(await screen.findByTestId('log-error')).toHaveTextContent(LOGS_COPY.loadFailed);
  });

  it('follow appends lines, and closing the view aborts the stream', async () => {
    api.getServiceLogs.mockResolvedValue(page([entry('old')]));
    let signal: AbortSignal | undefined;
    let push: ((entries: readonly LogEntryView[]) => void) | undefined;
    api.followServiceLogs.mockImplementation((options: { signal: AbortSignal; onEntries: typeof push }) => {
      signal = options.signal;
      push = options.onEntries;
      return new Promise((resolve) => {
        options.signal.addEventListener('abort', () => {
          resolve({ ok: true, reason: 'aborted' });
        });
      });
    });
    const user = userEvent.setup();
    const { unmount } = render();
    await screen.findByText('old');
    await user.click(screen.getByRole('switch', { name: 'Follow' }));
    await waitFor(() => {
      expect(api.followServiceLogs).toHaveBeenCalledTimes(1);
    });
    act(() => {
      push?.([entry('live one')]);
    });
    expect(await screen.findByText('live one')).toBeInTheDocument();
    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);
  });

  it('turning Follow off aborts; a stream that ends on its own turns Follow off with a notice', async () => {
    api.getServiceLogs.mockResolvedValue(page([]));
    const signals: AbortSignal[] = [];
    api.followServiceLogs.mockImplementationOnce((options: { signal: AbortSignal }) => {
      signals.push(options.signal);
      return new Promise(() => undefined);
    });
    api.followServiceLogs.mockImplementationOnce(() =>
      Promise.resolve({ ok: false, code: 'RUNTIME_LOG_FOLLOW_LIMIT_REACHED', message: 'm', unauthorized: false }),
    );
    const user = userEvent.setup();
    render();
    await screen.findByTestId('log-empty');
    const toggle = screen.getByRole('switch', { name: 'Follow' });
    await user.click(toggle);
    await user.click(toggle);
    expect(signals[0]?.aborted).toBe(true);
    await user.click(toggle);
    expect(await screen.findByTestId('log-follow-notice')).toHaveTextContent(LOGS_COPY.followLimit);
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });
});
