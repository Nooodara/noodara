// RED for 05-31-PLAN.md Task 2 (gap 6 / T-5G-27, .planning/todos/pending/2026-09-19-trust-fingerprint-toctou.md
// item 3): before this plan, `handleConfirm` sent no request body at all and re-fetched/compared
// the LIVE `server` prop against itself, so a `server.updated` event swapping `pendingFingerprint`
// mid-review was never caught. This file's key case (below) proves the fix: the dialog must send
// exactly the fingerprint it displayed when it opened, never whatever is current at click time.
//
// 08-17-PLAN.md Task 3 (D-10, §9 #14/#18): the two mono `Trusted: …`/`Observed: …` spans are
// replaced by two `Fingerprint` instances in block-aligned diff mode, labelled "Trusted"/"New"
// (never "old"/"Observed") -- the assertions below that used to match a single
// `Observed: <full string>` text node now assert the "New" caption plus a distinguishing block
// from the fingerprint's own body instead. `handleConfirm`, the `FINGERPRINT_MISMATCH` branch and
// the typed-name gate are untouched by this plan and stay covered by the unmodified cases below.
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, renderUi, screen, userEvent } from '@noodara/ui/testing';
import { TrustFingerprintDialog, type TrustFingerprintServer } from './TrustFingerprintDialog';
import type { ApiResult, ServerView } from '../lib/api-client';

const apiSendMock = vi.fn<(...args: unknown[]) => Promise<ApiResult<ServerView>>>();
const requireSessionMock = vi.fn<() => void>();

vi.mock('../lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api-client')>()),
  apiSend: (...args: unknown[]) => apiSendMock(...args),
}));

vi.mock('../lib/require-session', () => ({
  requireSession: () => {
    requireSessionMock();
  },
}));

const NOW = new Date('2026-09-20T12:00:00.000Z');
const FP_A = 'SHA256:aaaa000000000000000000000000000000000000000';
const FP_B = 'SHA256:bbbb000000000000000000000000000000000000000';

function buildServer(overrides: Partial<TrustFingerprintServer> = {}): TrustFingerprintServer {
  return {
    id: 'srv-1',
    name: 'trust-target',
    host: '10.0.0.9',
    sshPort: 22,
    hostFingerprint: 'SHA256:trusted0000000000000000000000000000000000',
    hostFingerprintCapturedAt: '2026-09-01T00:00:00.000Z',
    pendingFingerprint: FP_A,
    pendingFingerprintSeenAt: '2026-09-20T11:00:00.000Z',
    ...overrides,
  };
}

async function typeAndConfirm(name: string): Promise<void> {
  const user = userEvent.setup();
  await user.type(screen.getByRole('textbox'), name);
  await user.click(screen.getByRole('button', { name: 'Trust new fingerprint' }));
}

// Harness component so the test can swap the `server` prop's `pendingFingerprint` while `open`
// stays `true` and the dialog component instance is never unmounted -- the exact interleaving a
// live `server.updated` SSE event produces (the caller, `servers/[id]/page.tsx`, always threads the
// current prop straight through and is not touched by this plan). The trigger is a plain DOM button
// fired via `fireEvent` (never `userEvent`, which correctly refuses to click through Radix's real
// `pointer-events: none` scroll-lock on the rest of the page while the modal is open) -- this
// button exists only to drive the harness, not to model a real user interaction.
function Harness({
  initialServer,
  onOpenChange,
  onSettled,
}: {
  readonly initialServer: TrustFingerprintServer;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSettled: () => void;
}) {
  const [server, setServer] = useState(initialServer);
  return (
    <>
      <TrustFingerprintDialog open server={server} onOpenChange={onOpenChange} onSettled={onSettled} now={NOW} />
      <button type="button" onClick={() => { setServer({ ...server, pendingFingerprint: FP_B }); }}>
        simulate-swap
      </button>
    </>
  );
}

beforeEach(() => {
  apiSendMock.mockReset();
  requireSessionMock.mockReset();
});

describe('TrustFingerprintDialog', () => {
  it('renders the pendingFingerprint displayed at open time through the "New" Fingerprint block', () => {
    renderUi(
      <TrustFingerprintDialog
        open
        server={buildServer({ pendingFingerprint: FP_A })}
        onOpenChange={vi.fn()}
        onSettled={vi.fn()}
        now={NOW}
      />,
    );

    expect(screen.getByText('New')).toBeInTheDocument();
    expect(screen.getByText('aaaa')).toBeInTheDocument();
  });

  it('labels the two fingerprints "Trusted"/"New" -- never "old" or "Observed" -- and never marks a difference by colour', () => {
    const { container } = renderUi(
      <TrustFingerprintDialog
        open
        server={buildServer({ pendingFingerprint: FP_A })}
        onOpenChange={vi.fn()}
        onSettled={vi.fn()}
        now={NOW}
      />,
    );

    expect(screen.getByText('Trusted')).toBeInTheDocument();
    expect(screen.getByText('New')).toBeInTheDocument();
    expect(screen.queryByText(/\bold\b/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Observed/)).not.toBeInTheDocument();
    expect(container.innerHTML).not.toMatch(/text-status|bg-status|text-accent|bg-accent|text-red|text-green/);
  });

  it('marks at least one differing block at font-semibold full ink and at least one matching block at font-normal secondary ink', () => {
    renderUi(
      <TrustFingerprintDialog
        open
        server={buildServer({ pendingFingerprint: FP_A })}
        onOpenChange={vi.fn()}
        onSettled={vi.fn()}
        now={NOW}
      />,
    );

    // FP_A's first block ("aaaa") differs from the trusted fixture's own first block ("trus");
    // both fingerprints share the same all-zero tail, so at least one later block matches too.
    const differingBlock = screen.getByText('aaaa');
    expect(differingBlock.className).toMatch(/font-semibold/);
    expect(differingBlock.className).toMatch(/text-ink\b/);

    const matchingBlock = screen.getAllByText('0000')[0];
    expect(matchingBlock).toBeDefined();
    expect(matchingBlock?.className).toMatch(/font-normal/);
    expect(matchingBlock?.className).toMatch(/text-ink-secondary/);
  });

  it('regression: the confirm button stays disabled until the exact server name is typed, even with the diff rendered', async () => {
    renderUi(
      <TrustFingerprintDialog
        open
        server={buildServer({ pendingFingerprint: FP_A })}
        onOpenChange={vi.fn()}
        onSettled={vi.fn()}
        now={NOW}
      />,
    );

    const confirmButton = screen.getByRole('button', { name: 'Trust new fingerprint' });
    expect(confirmButton).toBeDisabled();

    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox'), 'not-quite-right');
    expect(confirmButton).toBeDisabled();

    await user.clear(screen.getByRole('textbox'));
    await user.type(screen.getByRole('textbox'), 'trust-target');
    expect(confirmButton).toBeEnabled();
  });

  // The key RED case (05-31-PLAN.md Task 2): open with pending = FP_A, then a live `server.updated`
  // swaps the prop to FP_B while the dialog stays open. Confirming must send FP_A -- the value this
  // dialog actually displayed -- never FP_B, and never no body at all.
  it('sends the fingerprint displayed at open time, not the live prop, after a mid-review swap', async () => {
    apiSendMock.mockResolvedValue({ ok: true, data: {} as ServerView });
    const onOpenChange = vi.fn();
    const onSettled = vi.fn();

    renderUi(
      <Harness initialServer={buildServer({ pendingFingerprint: FP_A })} onOpenChange={onOpenChange} onSettled={onSettled} />,
    );

    expect(screen.getByText('aaaa')).toBeInTheDocument();

    // The Radix Dialog marks every sibling outside its own Portal aria-hidden while open (a real
    // accessibility feature -- assistive tech should never reach background content behind a modal)
    // -- `hidden: true` is needed just to query the harness's own trigger button; `fireEvent` (not
    // `userEvent`) is what actually lets the click land despite the page's real pointer-events lock.
    fireEvent.click(screen.getByRole('button', { name: 'simulate-swap', hidden: true }));

    // The displayed value must not have silently followed the live prop -- FP_A's own first block
    // ("aaaa") is still shown, FP_B's ("bbbb") never appears.
    expect(screen.getByText('aaaa')).toBeInTheDocument();
    expect(screen.queryByText('bbbb')).not.toBeInTheDocument();

    await typeAndConfirm('trust-target');

    expect(apiSendMock).toHaveBeenCalledTimes(1);
    expect(apiSendMock).toHaveBeenCalledWith('POST', '/api/servers/srv-1/trust-fingerprint', {
      fingerprint: FP_A,
    });
  });

  it('sends the exact snapshotted fingerprint as the POST body on a plain confirm (no swap)', async () => {
    apiSendMock.mockResolvedValue({ ok: true, data: {} as ServerView });

    renderUi(
      <TrustFingerprintDialog
        open
        server={buildServer({ pendingFingerprint: FP_A })}
        onOpenChange={vi.fn()}
        onSettled={vi.fn()}
        now={NOW}
      />,
    );

    await typeAndConfirm('trust-target');

    expect(apiSendMock).toHaveBeenCalledWith('POST', '/api/servers/srv-1/trust-fingerprint', {
      fingerprint: FP_A,
    });
  });

  it('on FINGERPRINT_MISMATCH, closes the confirmation and calls onSettled so the caller refetches', async () => {
    apiSendMock.mockResolvedValue({
      ok: false,
      code: 'FINGERPRINT_MISMATCH',
      message: 'Submitted fingerprint no longer matches the pending fingerprint',
      unauthorized: false,
    });
    const onOpenChange = vi.fn();
    const onSettled = vi.fn();

    renderUi(
      <TrustFingerprintDialog
        open
        server={buildServer({ pendingFingerprint: FP_A })}
        onOpenChange={onOpenChange}
        onSettled={onSettled}
        now={NOW}
      />,
    );

    await typeAndConfirm('trust-target');

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('on SERVER_NOT_TRUSTABLE, shows the copy inline and calls onSettled without closing', async () => {
    apiSendMock.mockResolvedValue({
      ok: false,
      code: 'SERVER_NOT_TRUSTABLE',
      message: 'Server is not in a state that can trust a fingerprint',
      unauthorized: false,
    });
    const onOpenChange = vi.fn();
    const onSettled = vi.fn();

    renderUi(
      <TrustFingerprintDialog
        open
        server={buildServer({ pendingFingerprint: FP_A })}
        onOpenChange={onOpenChange}
        onSettled={onSettled}
        now={NOW}
      />,
    );

    await typeAndConfirm('trust-target');

    expect(screen.getByText("There's nothing to trust in this server's current state.")).toBeInTheDocument();
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('on success, closes the dialog and calls onSettled, issuing no second /connect request of its own', async () => {
    apiSendMock.mockResolvedValue({ ok: true, data: {} as ServerView });
    const onOpenChange = vi.fn();
    const onSettled = vi.fn();

    renderUi(
      <TrustFingerprintDialog
        open
        server={buildServer({ pendingFingerprint: FP_A })}
        onOpenChange={onOpenChange}
        onSettled={onSettled}
        now={NOW}
      />,
    );

    await typeAndConfirm('trust-target');

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(apiSendMock).toHaveBeenCalledTimes(1);
  });

  it('never sends a request when pendingFingerprint is null at open time (defensive)', async () => {
    renderUi(
      <TrustFingerprintDialog
        open
        server={buildServer({ pendingFingerprint: null, pendingFingerprintSeenAt: null })}
        onOpenChange={vi.fn()}
        onSettled={vi.fn()}
        now={NOW}
      />,
    );

    await typeAndConfirm('trust-target');

    expect(apiSendMock).not.toHaveBeenCalled();
    expect(screen.getByText("There's no fingerprint change to trust.")).toBeInTheDocument();
  });
});
