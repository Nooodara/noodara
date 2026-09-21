// RED for 05-19-PLAN.md Task 2 -- HostKeyChangedBanner.tsx doesn't exist yet. Covers D-03
// (05-UI-SPEC.md SS5.3): the exact leading sentence, the verification command, both fingerprints
// in full (never truncated/ellipsized) with their own labels and dates, the host:port they were
// observed against (the sequential_execution security instructions' own item 1 -- not literally in
// SS5.3's copy but required so the admin knows which server this is about), the trust action, and
// error_code in mono. Also covers the UF-01 aftermath: once the backend clears `pendingFingerprint`
// (apps/control-plane/src/services/edit-server.ts's ERROR/identity-changed branch), the trust
// affordance must disappear entirely rather than reach an unreachable/stale action.
import { describe, expect, it, vi } from 'vitest';
import { renderUi, screen, userEvent } from '@noodara/ui/testing';
import { HostKeyChangedBanner } from './HostKeyChangedBanner';

const NOW = new Date('2026-09-19T12:00:00.000Z');
const TRUSTED_FINGERPRINT = 'SHA256:trusted0000000000000000000000000000000000';
const OBSERVED_FINGERPRINT = 'SHA256:observed00000000000000000000000000000000';

describe('HostKeyChangedBanner', () => {
  it('renders the exact SS5.3 leading sentence, the verification command and error_code HOST_KEY_CHANGED in mono', () => {
    renderUi(
      <HostKeyChangedBanner
        host="10.0.0.5"
        sshPort={22}
        hostFingerprint={TRUSTED_FINGERPRINT}
        hostFingerprintCapturedAt="2026-09-01T00:00:00.000Z"
        pendingFingerprint={OBSERVED_FINGERPRINT}
        pendingFingerprintSeenAt="2026-09-19T11:00:00.000Z"
        now={NOW}
        onTrustClick={vi.fn()}
      />,
    );

    expect(
      screen.getByText(
        "This server's host key changed since it was last trusted. This can mean the server was reinstalled, or that something is intercepting the connection. Verify the fingerprint on the server itself before continuing:",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub')).toBeInTheDocument();
    expect(screen.getByText('HOST_KEY_CHANGED', { exact: true })).toBeInTheDocument();
  });

  it('shows both fingerprints in full, labelled Trusted/Observed, with the host:port they were observed against', () => {
    renderUi(
      <HostKeyChangedBanner
        host="10.0.0.5"
        sshPort={2222}
        hostFingerprint={TRUSTED_FINGERPRINT}
        hostFingerprintCapturedAt="2026-09-01T00:00:00.000Z"
        pendingFingerprint={OBSERVED_FINGERPRINT}
        pendingFingerprintSeenAt="2026-09-19T11:00:00.000Z"
        now={NOW}
        onTrustClick={vi.fn()}
      />,
    );

    expect(screen.getByText(/Trusted:/)).toBeInTheDocument();
    expect(screen.getByText(TRUSTED_FINGERPRINT, { exact: false })).toBeInTheDocument();
    expect(screen.getByText(/Observed:/)).toBeInTheDocument();
    expect(screen.getByText(OBSERVED_FINGERPRINT, { exact: false })).toBeInTheDocument();
    expect(screen.getByText('10.0.0.5:2222', { exact: false })).toBeInTheDocument();
  });

  it('renders a Trust new fingerprint action that calls onTrustClick exactly once when a pending fingerprint exists', async () => {
    const user = userEvent.setup();
    const onTrustClick = vi.fn();
    renderUi(
      <HostKeyChangedBanner
        host="10.0.0.5"
        sshPort={22}
        hostFingerprint={TRUSTED_FINGERPRINT}
        hostFingerprintCapturedAt="2026-09-01T00:00:00.000Z"
        pendingFingerprint={OBSERVED_FINGERPRINT}
        pendingFingerprintSeenAt="2026-09-19T11:00:00.000Z"
        now={NOW}
        onTrustClick={onTrustClick}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Trust new fingerprint' }));
    expect(onTrustClick).toHaveBeenCalledTimes(1);
  });

  it('hides the Trust new fingerprint action entirely and shows "not available" when pendingFingerprint is null (UF-01: cleared by an identity-changing edit)', () => {
    renderUi(
      <HostKeyChangedBanner
        host="10.0.0.5"
        sshPort={22}
        hostFingerprint={TRUSTED_FINGERPRINT}
        hostFingerprintCapturedAt="2026-09-01T00:00:00.000Z"
        pendingFingerprint={null}
        pendingFingerprintSeenAt={null}
        now={NOW}
        onTrustClick={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Trust new fingerprint' })).not.toBeInTheDocument();
    expect(screen.getByText(/Observed:/)).toBeInTheDocument();
    expect(screen.getByText('not available', { exact: false })).toBeInTheDocument();
  });

  it('shows calm re-capture copy and hides the Trusted/Observed rows and verify command when both fingerprints are null (CR-01: an identity-changing edit left nothing to compare)', () => {
    renderUi(
      <HostKeyChangedBanner
        host="10.0.0.5"
        sshPort={22}
        hostFingerprint={null}
        hostFingerprintCapturedAt={null}
        pendingFingerprint={null}
        pendingFingerprintSeenAt={null}
        now={NOW}
        onTrustClick={vi.fn()}
      />,
    );

    expect(
      screen.getByText(
        "This server's saved host key no longer applies because its host or port changed. Retry the connection to capture the new host key, then verify it on the server itself before continuing.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Trusted:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Observed:/)).not.toBeInTheDocument();
    expect(screen.queryByText('ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub')).not.toBeInTheDocument();
    expect(screen.getByText('HOST_KEY_CHANGED', { exact: true })).toBeInTheDocument();
    expect(screen.getByText('10.0.0.5:22', { exact: false })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Trust new fingerprint' })).not.toBeInTheDocument();
  });

  it('carries a stable data-testid for E2E/page-level assertions', () => {
    renderUi(
      <HostKeyChangedBanner
        host="10.0.0.5"
        sshPort={22}
        hostFingerprint={TRUSTED_FINGERPRINT}
        hostFingerprintCapturedAt="2026-09-01T00:00:00.000Z"
        pendingFingerprint={OBSERVED_FINGERPRINT}
        pendingFingerprintSeenAt="2026-09-19T11:00:00.000Z"
        now={NOW}
        onTrustClick={vi.fn()}
      />,
    );

    expect(screen.getByTestId('host-key-changed-banner')).toBeInTheDocument();
  });
});
