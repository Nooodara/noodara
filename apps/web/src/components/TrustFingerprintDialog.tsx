'use client';

// D-03 (05-UI-SPEC.md SS5.7) -- the type-the-name trust-new-fingerprint confirmation, the same
// friction as delete (DeleteServerDialog.tsx), since this is the one action that can hand
// credentials to an impostor host if trusted carelessly (05-01-SUMMARY.md's UF-01 finding is
// exactly what happens when this path is not defended carefully).
//
// CONTRACT WITH THE BACKEND (read apps/control-plane/src/routes/servers.ts's own route +
// apps/control-plane/src/services/trust-fingerprint.ts before changing this file): plan 05-27
// (gap 6 / T-5G-27, .planning/todos/pending/2026-09-19-trust-fingerprint-toctou.md) changed `POST
// /api/servers/:id/trust-fingerprint` to REQUIRE a body `{ fingerprint: string }`. The service
// promotes `pending_fingerprint` into `host_fingerprint` only via an atomic conditional UPDATE
// scoped to `WHERE pending_fingerprint = <the submitted value>` -- a value that no longer matches
// the row's live pending fingerprint at commit time is rejected with 409 FINGERPRINT_MISMATCH and
// nothing is promoted (no status change, no activity event, no published event).
//
// This dialog snapshots `server.pendingFingerprint` (and its `pendingFingerprintSeenAt`) the
// instant it opens -- the `useEffect` below, keyed on `open` alone -- and renders and sends exactly
// that snapshot for as long as it stays open. A `server.updated` SSE event silently swapping the
// live `server` prop mid-review (this dialog's caller, `servers/[id]/page.tsx`, always threads the
// current prop straight through) can therefore no longer be trusted by accident: display and
// action are structurally coupled, the same way `DeleteServerDialog`'s `confirmName` couples them.
// On a FINGERPRINT_MISMATCH response the dialog closes and asks the caller to refetch, rather than
// silently retrying or accepting the new value -- the admin must review whatever is pending now and
// re-type the name from scratch.
//
// The former client-side re-GET-and-compare (this file's own previous defense, which only narrowed
// -- never closed -- the display/promote race, since it could only ever compare the live prop to
// itself) is removed entirely: enforcement now lives solely in the backend's atomic conditional
// UPDATE, which is strictly stronger than anything a pre-flight client check could offer.
import { useEffect, useState } from 'react';
import { DestructiveConfirmDialog, RelativeTime } from '@noodara/ui';
import { apiSend, type ServerView } from '../lib/api-client';
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
   *  refetch/resync the server: a real success, or a FINGERPRINT_MISMATCH abort. Never called on
   *  every keystroke or on a same-value re-render -- the caller owns refetching, this component
   *  never mutates its own copy of `server` in place. */
  readonly onSettled: () => void;
  /** The caller's own clock, explicit -- matches every other "as of"/relative-time surface. */
  readonly now: Date;
}

interface PendingSnapshot {
  readonly fingerprint: string;
  readonly seenAt: string | null;
}

export function TrustFingerprintDialog({ open, onOpenChange, server, onSettled, now }: TrustFingerprintDialogProps) {
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  // T-5G-31-01: what this dialog displayed the moment it opened -- captured once per `open`
  // transition (never re-captured while `open` stays true), so a live `server` prop update
  // mid-review never silently changes what gets displayed or sent. Fingerprint and its "seen at"
  // timestamp are captured together so the row never shows a value paired with the wrong date.
  const [snapshot, setSnapshot] = useState<PendingSnapshot | null>(null);

  useEffect(() => {
    if (open) {
      setError(undefined);
      setSubmitting(false);
      // Deliberately depends only on `open`, not `server` -- see the file-level doc comment. A
      // `server.updated` prop change while the dialog stays open must never retrigger this snapshot.
      setSnapshot(
        server?.pendingFingerprint === null || server?.pendingFingerprint === undefined
          ? null
          : { fingerprint: server.pendingFingerprint, seenAt: server.pendingFingerprintSeenAt },
      );
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
    if (snapshot === null) {
      setError(copyForErrorCode('NO_PENDING_FINGERPRINT'));
      return;
    }

    setSubmitting(true);
    setError(undefined);

    const result = await apiSend<ServerView>(
      'POST',
      `/api/servers/${encodeURIComponent(server.id)}/trust-fingerprint`,
      { fingerprint: snapshot.fingerprint },
    );
    setSubmitting(false);

    if (!result.ok) {
      if (result.unauthorized) {
        void requireSession();
        return;
      }
      if (result.code === 'FINGERPRINT_MISMATCH') {
        // T-5G-31-01/03: the value changed underneath this dialog between open and confirm -- the
        // backend's atomic conditional UPDATE refused to promote it, and nothing was changed
        // server-side. Close the confirmation (so DestructiveConfirmDialog resets its typed name on
        // the next open, T-5G-31-03) and let the caller refetch so the banner re-renders with
        // whatever is pending now; the admin must review it again and re-type the name from scratch.
        onOpenChange(false);
        onSettled();
        return;
      }
      if (result.code === 'NO_PENDING_FINGERPRINT' || result.code === 'SERVER_NOT_TRUSTABLE') {
        setError(copyForErrorCode(result.code));
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
          {snapshot === null ? 'Observed: not available' : `Observed: ${snapshot.fingerprint}`}
        </span>
        {snapshot?.seenAt === null || snapshot?.seenAt === undefined ? null : (
          <span className="text-caption text-ink-tertiary">
            seen <RelativeTime value={snapshot.seenAt} now={now} />
          </span>
        )}
      </div>
    </DestructiveConfirmDialog>
  );
}
