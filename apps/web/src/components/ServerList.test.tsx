import { describe, expect, it, vi } from 'vitest';
import { ServerList, type ServerListState } from './ServerList';
import { renderUi, screen, userEvent, within } from '@noodara/ui/testing';
import type { ServerView } from '../lib/api-client';

const NOW = new Date('2026-09-19T12:00:00.000Z');

function buildServer(overrides: Partial<ServerView> & Pick<ServerView, 'id' | 'name'>): ServerView {
  return {
    host: 'example.test',
    sshPort: 22,
    sshUser: 'root',
    status: 'CONNECTED',
    hostFingerprint: null,
    hostFingerprintCapturedAt: null,
    pendingFingerprint: null,
    pendingFingerprintSeenAt: null,
    hostname: null,
    osDistribution: null,
    osVersion: null,
    arch: null,
    cpuCores: null,
    ramMb: null,
    diskTotalMb: null,
    diskUsedMb: null,
    uptimeSeconds: null,
    dockerInstalled: null,
    dockerVersion: null,
    dockerComposeVersion: null,
    lastSeenAt: '2026-09-19T11:00:00.000Z',
    lastErrorCode: null,
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
    credentialType: 'ssh_password',
    ...overrides,
  };
}

function renderList(state: ServerListState, onAddServer = vi.fn()) {
  return renderUi(<ServerList state={state} now={NOW} onAddServer={onAddServer} />);
}

describe('ServerList empty state', () => {
  it('renders the exact title, the exact sentence, and exactly one "Add server" button', () => {
    renderList({ kind: 'ready', servers: [] });

    expect(screen.getByText('No servers yet')).toBeInTheDocument();
    expect(
      screen.getByText('Connect your first Ubuntu server to let Noodara discover it.'),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Add server' })).toBeInTheDocument();
  });
});

describe('ServerList loading state', () => {
  it('renders exactly five 44px row skeletons and zero spinner/progressbar/status elements', () => {
    const { container } = renderList({ kind: 'loading' });

    const skeletons = container.querySelectorAll('[data-height="44"]');
    expect(skeletons).toHaveLength(5);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(container.querySelectorAll('[class*="animate-spin"]')).toHaveLength(0);
  });
});

describe('ServerList error state', () => {
  it('renders the message verbatim, the code in a separate data-mono element, and a Retry that fires onRetry once', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    renderList({
      kind: 'error',
      error: { message: "Couldn't load servers. Something broke.", code: 'INTERNAL_ERROR' },
      onRetry,
    });

    expect(screen.getByText("Couldn't load servers. Something broke.")).toBeInTheDocument();
    const monoEl = screen.getByText('INTERNAL_ERROR');
    expect(monoEl).toHaveAttribute('data-mono', 'true');

    const retryButtons = screen.getAllByRole('button', { name: 'Retry' });
    expect(retryButtons).toHaveLength(1);
    await user.click(retryButtons[0] as HTMLElement);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('never renders an extra field carried on the error payload', () => {
    const error = { message: 'Something broke.', code: 'INTERNAL_ERROR', requestId: 'req-super-secret-123' };
    const { container } = renderList({ kind: 'error', error, onRetry: vi.fn() });

    expect(container.textContent).not.toContain('req-super-secret-123');
    expect(container.innerHTML).not.toContain('requestId');
  });
});

describe('ServerList populated state', () => {
  it('renders exactly two servers-row elements, each with name, host:port, StatusPill data-status, and a matching <time>', () => {
    const alpha = buildServer({ id: 'a', name: 'Alpha', host: 'alpha.example.test', sshPort: 22, status: 'CONNECTED' });
    const beta = buildServer({ id: 'b', name: 'Beta', host: 'beta.example.test', sshPort: 2222, status: 'ERROR' });

    renderList({ kind: 'ready', servers: [alpha, beta] });

    const rows = screen.getAllByTestId('servers-row');
    expect(rows).toHaveLength(2);

    const alphaRow = rows.find((row) => within(row).queryByText('Alpha') !== null);
    expect(alphaRow).toBeDefined();
    expect(within(alphaRow as HTMLElement).getByText('alpha.example.test:22')).toBeInTheDocument();
    const alphaPill = within(alphaRow as HTMLElement).getByTestId('status-pill');
    expect(alphaPill).toHaveAttribute('data-status', 'CONNECTED');
    const alphaTime = (alphaRow as HTMLElement).querySelector('time');
    expect(alphaTime).not.toBeNull();
    expect(alphaTime).toHaveAttribute('dateTime', alpha.lastSeenAt as string);

    const betaRow = rows.find((row) => within(row).queryByText('Beta') !== null);
    expect(betaRow).toBeDefined();
    expect(within(betaRow as HTMLElement).getByText('beta.example.test:2222')).toBeInTheDocument();
    expect(within(betaRow as HTMLElement).getByTestId('status-pill')).toHaveAttribute('data-status', 'ERROR');
  });

  it('renders one servers-row and no alternate container for a single server (D-09, no cards)', () => {
    const only = buildServer({ id: 'a', name: 'Alpha' });

    const { container } = renderList({ kind: 'ready', servers: [only] });

    expect(screen.getAllByTestId('servers-row')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="servers-row"]')).toHaveLength(1);
  });
});
