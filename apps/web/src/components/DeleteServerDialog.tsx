'use client';

// The delete-server confirmation (05-UI-SPEC.md SS5.7) -- D-03's type-the-name friction, built on
// `DestructiveConfirmDialog`'s own disabled-until-match gate. That client-side gate is a UX
// pre-check only; the API's own `CONFIRMATION_MISMATCH` is the enforced source of truth, surfaced
// here in the dialog's own error slot rather than a second, bespoke error element.
import { useEffect, useState } from 'react';
import { DestructiveConfirmDialog } from '@noodara/ui';
import { apiSend, type ServerView } from '../lib/api-client';
import { copyForErrorCode } from '../lib/error-copy';

export interface DeleteServerDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly server: ServerView | null;
  /** Called once the delete actually succeeds, so the caller can refetch/resync its own list. */
  readonly onDeleted: () => void;
}

interface DeleteServerResponse {
  readonly ok: true;
  readonly serverId: string;
}

export function DeleteServerDialog({ open, onOpenChange, server, onDeleted }: DeleteServerDialogProps) {
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (open) {
      setError(undefined);
    }
  }, [open]);

  if (server === null) {
    return null;
  }

  async function handleConfirm(confirmName: string): Promise<void> {
    if (server === null) return;

    const result = await apiSend<DeleteServerResponse>('DELETE', `/api/servers/${encodeURIComponent(server.id)}`, {
      confirmName,
    });

    if (!result.ok) {
      if (result.code === 'CONFIRMATION_MISMATCH') {
        setError(copyForErrorCode('CONFIRMATION_MISMATCH').replace('{name}', server.name));
        return;
      }
      setError(result.code === 'NETWORK_ERROR' ? result.message : copyForErrorCode(result.code));
      return;
    }

    onOpenChange(false);
    onDeleted();
  }

  return (
    <DestructiveConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Delete ${server.name}?`}
      body="This permanently deletes the server, its credential and its discovery history. Type the server name to confirm."
      confirmLabel="Delete server"
      requiredName={server.name}
      data-testid="delete-server-dialog"
      onConfirm={(typed) => void handleConfirm(typed)}
      {...(error === undefined ? {} : { error })}
    />
  );
}
