// RED for 05-19-PLAN.md Task 2 -- FirstTrustNotice.tsx doesn't exist yet. Covers D-02
// (05-UI-SPEC.md SS5.2): the exact leading sentence, the ssh-keygen verification command, the
// fingerprint itself in full mono, and a Dismiss action that never issues a request of its own --
// dismissal is a purely client-side, cosmetic decision (apps/web/src/lib/first-trust.ts owns
// whether to show this component at all; this component never reads that decision itself).
//
// 08-17-PLAN.md Task 2 (D-10): the fingerprint span + its own CopyButton pair is replaced by the
// shared `Fingerprint` component -- the full string is now split into a dimmed `SHA256:` prefix
// plus 4-character blocks, so the old single-text-node `getByText(FINGERPRINT)` assertion no
// longer matches; the cases below assert the prefix/blocks instead, and a new case proves the
// verify-command block keeps its own separate CopyButton untouched.
import { describe, expect, it, vi } from 'vitest';
import { renderUi, screen, userEvent } from '@noodara/ui/testing';
import { FirstTrustNotice } from './FirstTrustNotice';

const FINGERPRINT = 'SHA256:AbCdEf0123456789AbCdEf0123456789AbCdEf01234';

describe('FirstTrustNotice', () => {
  it('renders the exact SS5.2 leading sentence, the verification command and the fingerprint through Fingerprint (prefix + blocks)', () => {
    renderUi(<FirstTrustNotice fingerprint={FINGERPRINT} onDismiss={vi.fn()} />);

    expect(
      screen.getByText(
        "Noodara trusted this server's host key on first connection. Verify it matches what the server reports:",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub')).toBeInTheDocument();
    expect(screen.getByText('SHA256:')).toBeInTheDocument();
    expect(screen.getAllByText('AbCd').length).toBeGreaterThan(0);
  });

  it('renders the verify command with its own copy control and the fingerprint through one Fingerprint copy control -- two distinct copy affordances', () => {
    renderUi(<FirstTrustNotice fingerprint={FINGERPRINT} onDismiss={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Copy command' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy fingerprint' })).toBeInTheDocument();
  });

  it('calls onDismiss exactly once when Dismiss is clicked, and issues no request of its own', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    renderUi(<FirstTrustNotice fingerprint={FINGERPRINT} onDismiss={onDismiss} />);

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('carries a stable data-testid for E2E/page-level assertions', () => {
    renderUi(<FirstTrustNotice fingerprint={FINGERPRINT} onDismiss={vi.fn()} />);

    expect(screen.getByTestId('first-trust-notice')).toBeInTheDocument();
  });
});
