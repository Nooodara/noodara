// D-02 (05-UI-SPEC.md SS2.5 layout position 1 / SS5.2): the neutral, one-time notice shown the
// first time a server's host key is trusted on first connection. Whether this component is
// mounted at all is decided by the caller (apps/web/src/lib/first-trust.ts's
// shouldShowFirstTrustNotice) -- this component itself owns only the notice's own copy and its
// Dismiss action, which is purely client-side: it never sends a request of its own (there is
// nothing for the server to know about a dismissed notice), it only reports the click upward so
// the caller can persist it via apps/web/src/lib/first-trust.ts's dismissFirstTrustNotice.
//
// The permanent fingerprint row in the Connection group (ServerFacts.tsx) is a separate, always-
// visible surface -- dismissing this notice never affects it.
import { CopyButton, Notice } from '@noodara/ui';

const VERIFY_COMMAND = 'ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub';

export interface FirstTrustNoticeProps {
  readonly fingerprint: string;
  readonly onDismiss: () => void;
}

export function FirstTrustNotice({ fingerprint, onDismiss }: FirstTrustNoticeProps) {
  return (
    <Notice
      data-testid="first-trust-notice"
      message="Noodara trusted this server's host key on first connection. Verify it matches what the server reports:"
      onDismiss={onDismiss}
    >
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <code data-mono="true" className="break-all text-mono text-ink-secondary">
            {VERIFY_COMMAND}
          </code>
          <CopyButton value={VERIFY_COMMAND} label="Copy command" />
        </div>
        <div className="flex items-center gap-2">
          <span data-mono="true" className="break-all text-mono text-ink">
            {fingerprint}
          </span>
          <CopyButton value={fingerprint} label="Copy fingerprint" />
        </div>
      </div>
    </Notice>
  );
}
