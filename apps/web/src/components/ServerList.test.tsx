import { describe, expect, it, vi } from 'vitest';
import { ServerList } from './ServerList';
import { renderUi, screen, userEvent, within } from '@noodara/ui/testing';
import { TooltipProvider } from '@noodara/ui';
import type { ServerView } from '../lib/api-client';

const NOW = new Date('2026-09-19T12:00:00.000Z');

// Same narrowing helper this codebase already established (packages/domain/src/security/
// envelope.ts, packages/domain/src/validators/network.ts, apps/control-plane/src/env.ts) to
// narrow an already-guaranteed-defined value without tripping either of this project's two
// mutually-exclusive ESLint rules: no-non-null-assertion (bans `!`) and non-nullable-type-
// assertion-style (wants `!` over `as T` for null removal). A single, local, generic cast
// function sidesteps both -- the assertion lives in exactly one reviewed place.
function assertDefined<T>(value: T | undefined): T {
  return value as T;
}

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

describe('ServerList empty state', () => {
  it('renders the exact title, the exact sentence, and exactly one "Add server" button', () => {
    renderUi(<ServerList state={{ kind: 'ready', servers: [] }} now={NOW} onAddServer={vi.fn()} onEditServer={vi.fn()} onDeleteServer={vi.fn()} />);

    expect(screen.getByText('No servers yet')).toBeInTheDocument();
    expect(
      screen.getByText('Connect your first Ubuntu server to let Noodara discover it.'),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Add server' })).toBeInTheDocument();
  });

  // 08-05-PLAN.md Task 3 (D-02): the whole servers list -- empty or full -- is one InsetGroup
  // block; the empty state renders inside it rather than replacing it.
  it('renders servers-empty inside the same servers-list InsetGroup block, not in place of it', () => {
    renderUi(<ServerList state={{ kind: 'ready', servers: [] }} now={NOW} onAddServer={vi.fn()} onEditServer={vi.fn()} onDeleteServer={vi.fn()} />);

    const listBlock = screen.getByTestId('servers-list');
    expect(listBlock).toHaveAttribute('data-inset-group', 'true');
    expect(within(listBlock).getByTestId('servers-empty')).toBeInTheDocument();
  });
});

describe('ServerList loading state', () => {
  it('renders exactly five 44px row skeletons and zero spinner/progressbar/status elements', () => {
    const { container } = renderUi(<ServerList state={{ kind: 'loading' }} now={NOW} onAddServer={vi.fn()} onEditServer={vi.fn()} onDeleteServer={vi.fn()} />);

    const skeletons = container.querySelectorAll('[data-row="true"]');
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
    renderUi(
      <ServerList
        state={{
          kind: 'error',
          error: { message: "Couldn't load servers. Something broke.", code: 'INTERNAL_ERROR' },
          onRetry,
        }}
        now={NOW}
        onAddServer={vi.fn()}
        onEditServer={vi.fn()}
        onDeleteServer={vi.fn()}
      />,
    );

    expect(screen.getByText("Couldn't load servers. Something broke.")).toBeInTheDocument();
    const monoEl = screen.getByText('INTERNAL_ERROR');
    expect(monoEl).toHaveAttribute('data-mono', 'true');

    const retryButtons = screen.getAllByRole('button', { name: 'Retry' });
    expect(retryButtons).toHaveLength(1);
    await user.click(assertDefined(retryButtons[0]));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('never renders an extra field carried on the error payload', () => {
    const error = { message: 'Something broke.', code: 'INTERNAL_ERROR', requestId: 'req-super-secret-123' };
    const { container } = renderUi(
      <ServerList state={{ kind: 'error', error, onRetry: vi.fn() }} now={NOW} onAddServer={vi.fn()} onEditServer={vi.fn()} onDeleteServer={vi.fn()} />,
    );

    expect(container.textContent).not.toContain('req-super-secret-123');
    expect(container.innerHTML).not.toContain('requestId');
  });
});

describe('ServerList populated state', () => {
  it('renders exactly two servers-row elements, each with name, host:port, StatusPill data-status, and a matching <time>', () => {
    const alpha = buildServer({ id: 'a', name: 'Alpha', host: 'alpha.example.test', sshPort: 22, status: 'CONNECTED' });
    const beta = buildServer({ id: 'b', name: 'Beta', host: 'beta.example.test', sshPort: 2222, status: 'ERROR' });

    renderUi(<ServerList state={{ kind: 'ready', servers: [alpha, beta] }} now={NOW} onAddServer={vi.fn()} onEditServer={vi.fn()} onDeleteServer={vi.fn()} />);

    const rows = screen.getAllByTestId('servers-row');
    expect(rows).toHaveLength(2);

    const alphaRow = assertDefined(rows.find((row) => within(row).queryByText('Alpha') !== null));
    expect(within(alphaRow).getByText('alpha.example.test:22')).toBeInTheDocument();
    const alphaPill = within(alphaRow).getByTestId('status-pill');
    expect(alphaPill).toHaveAttribute('data-status', 'CONNECTED');
    const alphaTime = alphaRow.querySelector('time');
    expect(alphaTime).not.toBeNull();
    expect(alphaTime).toHaveAttribute('dateTime', alpha.lastSeenAt);

    const betaRow = assertDefined(rows.find((row) => within(row).queryByText('Beta') !== null));
    expect(within(betaRow).getByText('beta.example.test:2222')).toBeInTheDocument();
    expect(within(betaRow).getByTestId('status-pill')).toHaveAttribute('data-status', 'ERROR');
  });

  // 08-05-PLAN.md Task 3 (D-02): servers-list resolves to the InsetGroup block, with every row
  // inside it.
  it('resolves servers-list to the InsetGroup block, with every servers-row inside it', () => {
    const alpha = buildServer({ id: 'a', name: 'Alpha' });
    const beta = buildServer({ id: 'b', name: 'Beta' });

    renderUi(<ServerList state={{ kind: 'ready', servers: [alpha, beta] }} now={NOW} onAddServer={vi.fn()} onEditServer={vi.fn()} onDeleteServer={vi.fn()} />);

    const listBlock = screen.getByTestId('servers-list');
    expect(listBlock).toHaveAttribute('data-inset-group', 'true');
    expect(within(listBlock).getAllByTestId('servers-row')).toHaveLength(2);
  });

  it('renders one servers-row and no alternate container for a single server (D-09, no cards)', () => {
    const only = buildServer({ id: 'a', name: 'Alpha' });

    const { container } = renderUi(
      <ServerList state={{ kind: 'ready', servers: [only] }} now={NOW} onAddServer={vi.fn()} onEditServer={vi.fn()} onDeleteServer={vi.fn()} />,
    );

    expect(screen.getAllByTestId('servers-row')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="servers-row"]')).toHaveLength(1);
  });
});

// 08-16-PLAN.md Task 1 (UI-07/D-11): the servers list's own one authored moment -- a 40ms-per-index
// stagger on first load only, never blocking interaction, never replayed on a later re-render. The
// identical technique DiscoveryStep.tsx (08-18-PLAN.md) already established for its own raw-checks
// stagger: `data-entering="true"` plus a rendered `transitionDelay`, asserted on the rendered value
// rather than on wall-clock timing.
describe('ServerList first-load stagger (UI-07/D-11)', () => {
  it('marks every row entering with a 40ms-per-index delay, in DOM order, on the first render with data', () => {
    const servers = Array.from({ length: 3 }, (_, index) => buildServer({ id: `s${String(index)}`, name: `Server ${String(index)}` }));

    renderUi(
      <ServerList state={{ kind: 'ready', servers }} now={NOW} onAddServer={vi.fn()} onEditServer={vi.fn()} onDeleteServer={vi.fn()} />,
    );

    const rows = screen.getAllByTestId('servers-row');
    expect(rows).toHaveLength(3);
    rows.forEach((row, index) => {
      expect(row).toHaveAttribute('data-entering', 'true');
      expect(row.getAttribute('style') ?? '').toContain(`${String(index * 40)}ms`);
      expect(row.className).not.toMatch(/pointer-events-none/);
    });
  });

  it('caps the stagger delay so a long list does not leave its last row waiting far longer than an 8-row list would', () => {
    const servers = Array.from({ length: 12 }, (_, index) => buildServer({ id: `s${String(index)}`, name: `Server ${String(index)}` }));

    renderUi(
      <ServerList state={{ kind: 'ready', servers }} now={NOW} onAddServer={vi.fn()} onEditServer={vi.fn()} onDeleteServer={vi.fn()} />,
    );

    const rows = screen.getAllByTestId('servers-row');
    const lastRow = rows[rows.length - 1];
    const secondToLastRow = rows[rows.length - 2];
    expect(lastRow).toHaveAttribute('data-entering', 'true');
    const lastRowStyle = lastRow?.getAttribute('style') ?? '';
    const secondToLastRowStyle = secondToLastRow?.getAttribute('style') ?? '';
    expect(lastRowStyle).not.toBe('');
    // Both are past the cap, so both carry the same, capped delay -- the last row does not wait
    // longer than the row before it once the cap is reached.
    expect(lastRowStyle).toBe(secondToLastRowStyle);
    expect(lastRowStyle).not.toContain(`${String(11 * 40)}ms`);
  });

  it('does not replay the entrance for rows already on screen when the list re-renders', () => {
    const alpha = buildServer({ id: 'a', name: 'Alpha' });
    const beta = buildServer({ id: 'b', name: 'Beta' });

    const result = renderUi(
      <ServerList state={{ kind: 'ready', servers: [alpha, beta] }} now={NOW} onAddServer={vi.fn()} onEditServer={vi.fn()} onDeleteServer={vi.fn()} />,
    );

    expect(screen.getAllByTestId('servers-row')[0]).toHaveAttribute('data-entering', 'true');

    // Same rendered tree shape (TooltipProvider > ServerList), reconciled in place rather than
    // remounted -- ServerFacts.test.tsx's own precedent for why `rerender` must re-supply
    // `renderUi`'s TooltipProvider wrapper explicitly (RelativeTime's ISO tooltip needs it).
    result.rerender(
      <TooltipProvider delayDuration={0}>
        <ServerList
          state={{ kind: 'ready', servers: [alpha, beta] }}
          now={new Date(NOW.getTime() + 60_000)}
          onAddServer={vi.fn()}
          onEditServer={vi.fn()}
          onDeleteServer={vi.fn()}
        />
      </TooltipProvider>,
    );

    screen.getAllByTestId('servers-row').forEach((row) => {
      expect(row).not.toHaveAttribute('data-entering');
    });
  });
});
