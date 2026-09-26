// RED for Task 2 (05-14-PLAN.md) -- `ServerFacts.tsx` doesn't exist yet. Covers DETL-01's field
// coverage, the "as of" captions, the dimmed variant and the never-a-zero rule (this component
// test's own division of labour per docs/adr/0005-ui-package-and-component-testing.md: field
// coverage/captions/the dimmed attribute here, the real computed opacity difference and full
// navigation flow in tests/e2e/server-detail.spec.ts).
//
// 08-17-PLAN.md Task 2 (D-10): the "Host fingerprint" row's `LabelValue mono copyable` is
// replaced by the shared `Fingerprint` component -- the cases below assert the SHA256: prefix and
// 4-char blocks instead of a single mono text node, and the null-fingerprint placeholder case.
import { describe, expect, it } from 'vitest';
import { formatDiskUsage, formatMb, formatRelativeTime, formatUptime } from '@noodara/ui';
import { renderUi, screen, within } from '@noodara/ui/testing';
import { ServerFacts } from './ServerFacts';
import type { ServerView } from '../lib/api-client';

const NOW = new Date('2026-09-19T12:00:00.000Z');

// Minimal, locally-built ServerView fixture -- same precedent as apps/web/src/lib/server-store.test.ts's
// own `buildServer` (no shared builder exists yet in apps/web).
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
    lastSeenAt: null,
    lastErrorCode: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    credentialType: 'ssh_password',
    ...overrides,
  };
}

const LAST_SEEN_AT = '2026-09-19T11:58:00.000Z';
const FINGERPRINT_CAPTURED_AT = '2026-09-01T00:00:00.000Z';

function buildDiscoveredServer(overrides: Partial<ServerView> & Pick<ServerView, 'id' | 'name'> = { id: 's1', name: 'srv-1' }): ServerView {
  return buildServer({
    hostname: 'srv-1.internal',
    osDistribution: 'Ubuntu',
    osVersion: '24.04',
    arch: 'x86_64',
    cpuCores: 4,
    ramMb: 8192,
    diskTotalMb: 40960,
    diskUsedMb: 18432,
    uptimeSeconds: 93784,
    dockerInstalled: true,
    dockerVersion: '27.3.1',
    dockerComposeVersion: 'v2.29.7',
    hostFingerprint: 'SHA256:abcdef1234567890',
    hostFingerprintCapturedAt: FINGERPRINT_CAPTURED_AT,
    lastSeenAt: LAST_SEEN_AT,
    ...overrides,
  });
}

describe('ServerFacts', () => {
  it('renders exactly four stat tiles, with values equal to the format.ts outputs', () => {
    const server = buildDiscoveredServer();
    renderUi(<ServerFacts server={server} now={NOW} />);

    expect(screen.getByTestId('server-fact-cpu-cores')).toHaveTextContent('4');
    expect(screen.getByTestId('server-fact-ram')).toHaveTextContent(formatMb(server.ramMb));
    expect(screen.getByTestId('server-fact-disk')).toHaveTextContent(formatDiskUsage(server.diskUsedMb, server.diskTotalMb).text);
    expect(screen.getByTestId('server-fact-uptime')).toHaveTextContent(formatUptime(server.uptimeSeconds));

    // Scoped to the tiles container: Plan 05-16 added `data-mono` to LabelValue's own value span
    // too (packages/ui/src/LabelValue.tsx), so a document-wide query would also pick up this
    // component's mono label/value rows below (Hostname, Architecture, versions, Connection
    // fields) -- this assertion is specifically about the four stat tiles, not the whole screen.
    expect(screen.getByTestId('server-facts-tiles').querySelectorAll('[data-mono="true"]')).toHaveLength(4);
  });

  it("carries the disk tile's fraction in data-fraction, and renders no meter on the other three tiles", () => {
    const server = buildDiscoveredServer();
    const { container } = renderUi(<ServerFacts server={server} now={NOW} />);

    const disk = screen.getByTestId('server-fact-disk');
    const meter = disk.querySelector('[data-fraction]');
    expect(meter).not.toBeNull();
    expect(meter).toHaveAttribute('data-fraction', String(formatDiskUsage(server.diskUsedMb, server.diskTotalMb).fraction));

    expect(container.querySelectorAll('[data-fraction]')).toHaveLength(1);
  });

  it('renders every DETL-01 field, by label', () => {
    const server = buildDiscoveredServer();
    renderUi(<ServerFacts server={server} now={NOW} />);

    for (const label of [
      'Hostname',
      'OS',
      'Architecture',
      'Engine version',
      'Compose version',
      'Host',
      'Port',
      'SSH user',
      'Credential',
      'Host fingerprint',
      'Last seen',
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('renders the Host fingerprint value through Fingerprint -- the SHA256: prefix and its 4-character blocks', () => {
    const server = buildDiscoveredServer({ id: 's1', name: 'srv-1', hostFingerprint: 'SHA256:abcdef1234567890' });
    renderUi(<ServerFacts server={server} now={NOW} />);

    const connectionGroup = screen.getByTestId('server-facts-connection');
    expect(within(connectionGroup).getByText('SHA256:')).toBeInTheDocument();
    expect(within(connectionGroup).getByText('abcd')).toBeInTheDocument();
    expect(within(connectionGroup).getByRole('button', { name: 'Copy Host fingerprint' })).toBeInTheDocument();
  });

  it('renders the shared PLACEHOLDER (never an empty block grid) for a null Host fingerprint', () => {
    const server = buildDiscoveredServer({ id: 's1', name: 'srv-1', hostFingerprint: null, hostFingerprintCapturedAt: null });
    renderUi(<ServerFacts server={server} now={NOW} />);

    const connectionGroup = screen.getByTestId('server-facts-connection');
    expect(within(connectionGroup).queryByText('SHA256:')).not.toBeInTheDocument();
    expect(within(connectionGroup).getByText('—')).toBeInTheDocument();
  });

  it('carries an "as of" caption with the relative time for lastSeenAt on every tile and group value', () => {
    const server = buildDiscoveredServer();
    renderUi(<ServerFacts server={server} now={NOW} />);

    const expectedCaption = `as of ${formatRelativeTime(server.lastSeenAt, NOW)}`;
    // Every tile plus every non-fingerprint group row carries this exact caption -- at least one
    // instance is enough to prove the relative-time text is really produced by format.ts, and the
    // count below proves it is not just a single one-off caption somewhere on the page.
    expect(screen.getAllByText(expectedCaption).length).toBeGreaterThanOrEqual(4);
  });

  it('renders the shared placeholder (never a 0) for null cpuCores/ramMb/uptimeSeconds', () => {
    const server = buildDiscoveredServer({ id: 's1', name: 'srv-1', cpuCores: null, ramMb: null, uptimeSeconds: null });
    renderUi(<ServerFacts server={server} now={NOW} />);

    const cpu = screen.getByTestId('server-fact-cpu-cores');
    const ram = screen.getByTestId('server-fact-ram');
    const uptime = screen.getByTestId('server-fact-uptime');

    expect(cpu).not.toHaveTextContent('0');
    expect(ram).not.toHaveTextContent('0');
    expect(uptime).not.toHaveTextContent('0');
  });

  it('flips data-dimmed on every LabelValue and tile with the dimmed prop', () => {
    const server = buildDiscoveredServer();

    // Two independent renders, not `rerender` -- `renderUi` wraps its own root in
    // `TooltipProvider` (05-06-PLAN.md/ADR-0005), and the fingerprint row's `CopyButton` pulls in
    // `Tooltip`; RTL's `rerender` replaces the tree it was given directly, dropping that outer
    // wrapper (unlike `options.wrapper`), which throws "Tooltip must be used within
    // TooltipProvider" the moment a second render swaps in an un-wrapped tree.
    const notDimmed = renderUi(<ServerFacts server={server} now={NOW} />);
    const notDimmedEls = notDimmed.container.querySelectorAll('[data-dimmed]');
    expect(notDimmedEls.length).toBeGreaterThan(0);
    for (const el of notDimmedEls) {
      expect(el).toHaveAttribute('data-dimmed', 'false');
    }
    notDimmed.unmount();

    const dimmed = renderUi(<ServerFacts server={server} now={NOW} dimmed />);
    const dimmedEls = dimmed.container.querySelectorAll('[data-dimmed]');
    expect(dimmedEls.length).toBe(notDimmedEls.length);
    for (const el of dimmedEls) {
      expect(el).toHaveAttribute('data-dimmed', 'true');
    }
  });

  it('renders the exact UNSUPPORTED_OS warning copy inline, with no error-toned element, while still CONNECTED', () => {
    const server = buildDiscoveredServer({ id: 's1', name: 'srv-1', status: 'CONNECTED', lastErrorCode: 'UNSUPPORTED_OS' });
    renderUi(<ServerFacts server={server} now={NOW} warnings={['UNSUPPORTED_OS']} />);

    expect(
      screen.getByText('Outside the supported matrix (Ubuntu 22.04/24.04). Some features may not work as expected.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(document.querySelector('[data-tone="error"]')).toBeNull();
  });

  // 08-05-PLAN.md Task 2 (D-01/D-04): the three fact groups become InsetGroup blocks -- the
  // testid moves onto the InsetGroup's own block element (data-inset-group="true"), and the
  // group heading is InsetGroup's own <h3>, not a literal element this component still renders.
  it('wraps System, Docker and Connection each in an InsetGroup block, exposing the same testids and headings', () => {
    const server = buildDiscoveredServer();
    renderUi(<ServerFacts server={server} now={NOW} />);

    for (const [testId, heading] of [
      ['server-facts-system', 'System'],
      ['server-facts-docker', 'Docker'],
      ['server-facts-connection', 'Connection'],
    ] as const) {
      const block = screen.getByTestId(testId);
      expect(block).toHaveAttribute('data-inset-group', 'true');

      const headingEl = screen.getByRole('heading', { level: 3, name: heading });
      expect(headingEl.className).toMatch(/text-label/);
      expect(headingEl.className).toMatch(/uppercase/);
      expect(headingEl.className).toMatch(/text-ink-secondary/);
      expect(block.contains(headingEl)).toBe(false);
    }
  });

  // 08-05-PLAN.md Task 2 (D-04): "separación entre grupos" is --space-6 (24px) on the outer
  // container -- asserted via the outer wrapper's own class, since jsdom does not compute layout.
  it("separates the tiles row and each InsetGroup block by the D-04 24px gap (gap-6)", () => {
    const server = buildDiscoveredServer();
    const { container } = renderUi(<ServerFacts server={server} now={NOW} />);

    expect(container.firstElementChild).toHaveClass('gap-6');
  });

  it('renders no privateKey/passphrase label or a raw credential value anywhere -- only the human credentialType label', () => {
    const server = buildDiscoveredServer();
    renderUi(<ServerFacts server={server} now={NOW} />);

    // "Password" itself legitimately appears once, as the human label for `credentialType:
    // 'ssh_password'` (05-UI-SPEC.md SS2.5's Connection group) -- never a raw secret value.
    // `privateKey`/`passphrase` (the two other WireCredential field names, SEC-02) must never
    // appear at all, and neither must PEM's own private-key marker.
    expect(screen.queryByText(/privateKey/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/passphrase/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/BEGIN.*PRIVATE KEY/i)).not.toBeInTheDocument();
    expect(screen.getAllByText('Password')).toHaveLength(1);
  });

  // 08-11-PLAN.md Task 3 round 1 (deferred-items.md, pixel audit of server-detail-light-375.png):
  // at 375px the row was a fixed two-column grid (`grid-cols-2`), narrow enough that the widest
  // mono value ("176.3 GB of 910.7 GB" for Disk) wraps across three lines instead of sitting on
  // one. Below 480px the tiles stack to a single column so each tile's own width comes from the
  // full container instead of half of it; `sm:grid-cols-4` (the four-across desktop layout)
  // already existed and is untouched. Asserted as class presence -- jsdom has no real layout
  // engine to measure whether "176.3 GB of 910.7 GB" actually wraps.
  it('stacks the stat tiles to a single column below 480px, two from 480px, four from sm', () => {
    const server = buildDiscoveredServer();
    renderUi(<ServerFacts server={server} now={NOW} />);

    const grid = screen.getByTestId('server-facts-tiles');
    const classes = grid.className.split(/\s+/);
    expect(classes).toContain('grid-cols-1');
    expect(classes).toContain('min-[480px]:grid-cols-2');
    expect(classes).toContain('sm:grid-cols-4');
    expect(classes).not.toContain('grid-cols-2');
  });
});
