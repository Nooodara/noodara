'use client';

// D-03 (05-UI-SPEC.md SS5.7) -- the type-the-name trust-new-fingerprint confirmation, the same
// friction as delete (DeleteServerDialog.tsx), since this is the one action that can hand
// credentials to an impostor host if trusted carelessly (05-01-SUMMARY.md's UF-01 finding is
// exactly what happens when this path is not defended carefully).
//
// CONTRACT WITH THE BACKEND (read apps/control-plane/src/routes/servers.ts's own route +
// apps/control-plane/src/services/trust-fingerprint.ts before changing this file): `POST
// /api/servers/:id/trust-fingerprint` takes NO request body at all -- no `confirmName`, no
// fingerprint value. It promotes whatever `pendingFingerprint` is currently on the row, using only
// `:id`. The confirm dialog is real UX friction (a genuine barrier against a misclick), but
// display and action are NOT structurally coupled the way `DeleteServerDialog`'s `confirmName`
// couples them -- the server trusts whatever is pending at the moment this request lands, not
// whatever fingerprint this dialog happened to render when it opened.
//
// RESIDUAL RACE (documented per the executor's own item 4, not hidden): between this dialog
// opening and the admin clicking "Trust new fingerprint", the pending fingerprint could
// theoretically change again (a second HOST_KEY_CHANGED connect attempt landing mid-review, or an
// identity-changing edit clearing it, UF-01's own fix). This component closes as much of that
// window as the API allows: immediately before sending the real trust request, it re-fetches the
// server and refuses to proceed (no trust request is sent at all) unless the freshly-fetched
// `pendingFingerprint` is still byte-for-byte identical to the one this dialog displayed. If it
// differs (including having become `null`), the dialog reports that plainly and asks the admin to
// review the (now different) banner again, rather than trusting a value it no longer knows is
// current. This narrows, but per the API's own no-body contract cannot fully eliminate, the
// display-versus-promote race -- the server always promotes whatever is pending *at commit time*,
// which is a few milliseconds after this check, not at click time. A tighter guarantee would need
// the route to accept and verify the exact fingerprint being trusted, which is a backend change
// out of this plan's scope (flagged in the plan's own SUMMARY, not silently worked around here).
import { useEffect, useState } from 'react';
import { DestructiveConfirmDialog, RelativeTime } from '@noodara/ui';
import { apiGet, apiSend, type ServerView } from '../lib/api-client';
import { copyForErrorCode } from '../lib/error-copy';
import { requireSession } from '../lib/require-session';

export interface TrustFingerprintServer {
  readonly id: string;
  readonly name: string;
  readonly host: string;
  readonly sshPort: number;
  readonly hostFingerprint: string | null;
  readonly hostFingerprintCapturedAt: string | null;
  readonly pendingFingerprint: string | null;
  readonly pendingFingerprintSeenAt: string | null;
}

export interface TrustFingerprintDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly server: TrustFingerprintServer | null;
  /** Called once this dialog's own round trip settles in a way that should make the caller
   *  refetch/resync the server: a real success, or the race-detected abort above. Never called on
   *  every keystroke or on a same-value re-render -- the caller owns refetching, this component
   *  never mutates its own copy of `server` in place. */
  readonly onSettled: () => void;
  /** The caller's own clock, explicit -- matches every other "as of"/relative-time surface. */
  readonly now: Date;
}

const STALE_PENDING_MESSAGE =
  "The pending fingerprint changed since this dialog opened. Review the new value in the banner before trusting.";

export function TrustFingerprintDialog({ open, onOpenChange, server, onSettled, now }: TrustFingerprintDialogProps) {
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setError(undefined);
      setSubmitting(false);
    }
  }, [open]);

  if (server === null) {
    return null;
  }

  async function handleConfirm(): Promise<void> {
    if (server === null || submitting) return;

    // Defensive -- the banner never renders this dialog's opener when there is nothing pending
    // (05-UI-SPEC.md SS5.4: "the button should not be reachable otherwise"), but a component that
    // sends a real destructive request never trusts its own caller for that alone.
    if (server.pendingFingerprint === null) {
      setError(copyForErrorCode('NO_PENDING_FINGERPRINT'));
      return;
    }

    setSubmitting(true);
    setError(undefined);

    // Narrows (never fully closes -- see the file-level doc comment) the display-versus-promote
    // race: refuse to send the real trust request at all if what the server currently has pending
    // no longer matches what this dialog displayed.
    const latest = await apiGet<ServerView>(`/api/servers/${encodeURIComponent(server.id)}`);

    if (!latest.ok) {
      setSubmitting(false);
      if (latest.unauthorized) {
        void requireSession();
        return;
      }
      setError(latest.code === 'NETWORK_ERROR' ? latest.message : copyForErrorCode(latest.code));
      return;
    }

    if (latest.data.pendingFingerprint !== server.pendingFingerprint) {
      setSubmitting(false);
      setError(STALE_PENDING_MESSAGE);
      onSettled();
      return;
    }

    const result = await apiSend<ServerView>('POST', `/api/servers/${encodeURIComponent(server.id)}/trust-fingerprint`);
    setSubmitting(false);

    if (!result.ok) {
      if (result.unauthorized) {
        void requireSession();
        return;
      }
      if (result.code === 'CONFIRMATION_MISMATCH') {
        // Structurally unreachable against the real route today (it takes no confirmName), kept
        // as defensive handling only -- see the file-level doc comment.
        setError(copyForErrorCode('CONFIRMATION_MISMATCH').replace('{name}', server.name));
        return;
      }
      if (result.code === 'NO_PENDING_FINGERPRINT') {
        setError(copyForErrorCode('NO_PENDING_FINGERPRINT'));
        onSettled();
        return;
      }
      setError(result.code === 'NETWORK_ERROR' ? result.message : copyForErrorCode(result.code));
      return;
    }

    // Never auto-connect: closing the dialog and refetching is the entire success path. The
    // resulting PENDING server offers "Connect" as an explicit, user-initiated action elsewhere
    // (ServerDetailToolbar/derivePrimaryAction) -- this component issues no /connect request.
    onOpenChange(false);
    onSettled();
  }

  return (
    <DestructiveConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Trust new host key for ${server.name}?`}
      body="This lets Noodara connect using the new fingerprint below. Only continue if you've verified it on the server itself. Type the server name to confirm."
      confirmLabel="Trust new fingerprint"
      requiredName={server.name}
      data-testid="trust-fingerprint-dialog"
      onConfirm={() => void handleConfirm()}
      {...(error === undefined ? {} : { error })}
    >
      <div className="flex flex-col gap-2">
        <span data-mono="true" className="break-all text-mono text-ink-tertiary">
          {`Host: ${server.host}:${String(server.sshPort)}`}
        </span>
        <span data-mono="true" className="break-all text-mono text-ink">
          {server.hostFingerprint === null ? 'Trusted: not available' : `Trusted: ${server.hostFingerprint}`}
        </span>
        {server.hostFingerprintCapturedAt === null ? null : (
          <span className="text-caption text-ink-tertiary">
            captured <RelativeTime value={server.hostFingerprintCapturedAt} now={now} />
          </span>
        )}
        <span data-mono="true" className="break-all text-mono text-ink">
          {server.pendingFingerprint === null ? 'Observed: not available' : `Observed: ${server.pendingFingerprint}`}
        </span>
        {server.pendingFingerprintSeenAt === null ? null : (
          <span className="text-caption text-ink-tertiary">
            seen <RelativeTime value={server.pendingFingerprintSeenAt} now={now} />
          </span>
        )}
      </div>
    </DestructiveConfirmDialog>
  );
}
