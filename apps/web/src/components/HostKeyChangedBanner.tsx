// D-03 (05-UI-SPEC.md SS2.5 layout position 2 / SS5.3): the dedicated HOST_KEY_CHANGED banner --
// this replaces the generic DETL-02 error banner for this one code entirely (never rendered
// alongside it, see the detail page's own wiring).
//
// SECURITY (noodara-security skill; the executor's own item 1/6): both fingerprints render in
// FULL, mono, never truncated or ellipsized (no Tailwind `truncate`, `overflow-hidden` +
// `text-overflow` anywhere in this file -- long values wrap via `break-all` instead of being cut),
// each individually copyable and clearly labelled ("Trusted:"/"Observed:"), alongside the
// host:port they were both observed against -- an admin who only sees "Trust new fingerprint"
// with no visible identity has no way to catch a stale/wrong-server banner.
//
// `pendingFingerprint === null` is a real, reachable state -- not a defensive-only case -- once
// apps/control-plane/src/services/edit-server.ts's UF-01 fix clears it on an identity-changing
// edit made while `ERROR`/`HOST_KEY_CHANGED`. This banner never invents a value for that slot (no
// stale echo of what it used to be) and never renders "Trust new fingerprint" when there is
// nothing to trust (NO_PENDING_FINGERPRINT's own SS5.4 copy calls that button "defensive -- should
// not be reachable otherwise"; this is the affordance actually not being reachable, structurally,
// not just guarded server-side).
import { Banner, CopyButton, RelativeTime } from '@noodara/ui';

const VERIFY_COMMAND = 'ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub';
const NOT_AVAILABLE = 'not available';

const MONO_ROW_CLASSES = 'flex flex-wrap items-center gap-2';
const MONO_VALUE_CLASSES = 'break-all text-mono text-ink';

export interface HostKeyChangedBannerProps {
  readonly host: string;
  readonly sshPort: number;
  readonly hostFingerprint: string | null;
  readonly hostFingerprintCapturedAt: string | null;
  readonly pendingFingerprint: string | null;
  readonly pendingFingerprintSeenAt: string | null;
  /** The caller's own clock, explicit -- matches every other "as of"/relative-time surface in
   *  this app (ServerFacts.tsx, DiscoverySection.tsx). */
  readonly now: Date;
  readonly onTrustClick: () => void;
}

export function HostKeyChangedBanner({
  host,
  sshPort,
  hostFingerprint,
  hostFingerprintCapturedAt,
  pendingFingerprint,
  pendingFingerprintSeenAt,
  now,
  onTrustClick,
}: HostKeyChangedBannerProps) {
  return (
    <Banner
      data-testid="host-key-changed-banner"
      message="This server's host key changed since it was last trusted. This can mean the server was reinstalled, or that something is intercepting the connection. Verify the fingerprint on the server itself before continuing:"
      errorCode="HOST_KEY_CHANGED"
      {...(pendingFingerprint === null ? {} : { action: { label: 'Trust new fingerprint', onClick: onTrustClick } })}
    >
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <code data-mono="true" className="break-all text-mono text-ink-secondary">
            {VERIFY_COMMAND}
          </code>
          <CopyButton value={VERIFY_COMMAND} label="Copy command" />
        </div>

        <span data-mono="true" className="text-mono text-ink-tertiary">
          {`Host: ${host}:${String(sshPort)}`}
        </span>

        <div className={MONO_ROW_CLASSES}>
          <span data-mono="true" className={MONO_VALUE_CLASSES}>
            {hostFingerprint === null ? `Trusted: ${NOT_AVAILABLE}` : `Trusted: ${hostFingerprint}`}
          </span>
          {hostFingerprint === null ? null : <CopyButton value={hostFingerprint} label="Copy trusted fingerprint" />}
          {hostFingerprintCapturedAt === null ? null : (
            <span className="text-caption text-ink-tertiary">
              — captured <RelativeTime value={hostFingerprintCapturedAt} now={now} />
            </span>
          )}
        </div>

        <div className={MONO_ROW_CLASSES}>
          <span data-mono="true" className={MONO_VALUE_CLASSES}>
            {pendingFingerprint === null ? `Observed: ${NOT_AVAILABLE}` : `Observed: ${pendingFingerprint}`}
          </span>
          {pendingFingerprint === null ? null : <CopyButton value={pendingFingerprint} label="Copy observed fingerprint" />}
          {pendingFingerprintSeenAt === null ? null : (
            <span className="text-caption text-ink-tertiary">
              — seen <RelativeTime value={pendingFingerprintSeenAt} now={now} />
            </span>
          )}
        </div>
      </div>
    </Banner>
  );
}
