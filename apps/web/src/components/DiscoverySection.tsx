'use client';

// The Discovery section (DISC-02, 05-UI-SPEC.md SS2.5 layout position 6, SS4, D-05..D-08).
// Cold-loads the last completed run from GET /api/servers/:id/discovery on mount and on every
// shared-stream resync, and folds the caller's own accumulated `server.discovery_progress` checks
// (this run's live progress, cleared by the caller the instant a new run starts) through
// `buildChecklist` -- the fetched settled snapshot is never rendered directly, only ever through
// that one pure reducer, so D-05's "never invent progress" rule holds structurally rather than by
// convention alone.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DiscoveryCheck } from '@noodara/domain/discovery';
import type { ServerErrorCode, ServerStatus } from '@noodara/domain/server';
import { Button, formatRelativeTime } from '@noodara/ui';
import { apiGet, apiSend, type ApiErrorCode } from '../lib/api-client';
import { buildChecklist, summarize, type DiscoverySettledSnapshot } from '../lib/discovery-progress';
import { STEP_LABELS } from '../lib/discovery-steps';
import { copyForErrorCode, type ServiceErrorCode } from '../lib/error-copy';
import { useShellContext } from '../lib/shell-context';
import { DiscoveryStep } from './DiscoveryStep';

interface DiscoveryReadResponse {
  readonly collectedAt: string | null;
  readonly outcome: 'ok' | 'partial' | 'failed' | null;
  readonly checks: readonly DiscoveryCheck[];
  readonly warnings: readonly ServerErrorCode[];
}

const EMPTY_SETTLED: DiscoverySettledSnapshot = { collectedAt: null, checks: [], warnings: [] };

// D-05/SS4.3's exact caption -- a page opened mid-run explains why the checklist reset rather than
// showing the previous run's results.
const IN_PROGRESS_CAPTION = 'A new discovery run is in progress';

function isServiceErrorCode(code: ApiErrorCode): code is ServiceErrorCode {
  return code !== 'NETWORK_ERROR';
}

export interface DiscoverySectionProps {
  readonly serverId: string;
  readonly serverStatus: ServerStatus;
  readonly sshUser: string;
  /** This run's checks received live so far, accumulated by the caller and cleared the instant a
   *  new run starts (a transition into `CONNECTING`) -- ignored entirely by `buildChecklist`
   *  unless `serverStatus === 'CONNECTING'`. */
  readonly receivedChecks: readonly DiscoveryCheck[];
  /** The caller's own clock, explicit -- matches `ServerFacts`'s no-platform-clock discipline. */
  readonly now: Date;
}

export function DiscoverySection({ serverId, serverStatus, sshUser, receivedChecks, now }: DiscoverySectionProps) {
  const { registerResync } = useShellContext();
  const [settled, setSettled] = useState<DiscoverySettledSnapshot | null>(null);
  const [expanded, setExpanded] = useState(serverStatus === 'CONNECTING');
  const [rerunPending, setRerunPending] = useState(false);
  const [rerunError, setRerunError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const previousStatusRef = useRef(serverStatus);
  const previousReceivedCountRef = useRef(receivedChecks.length);

  const fetchSettled = useCallback((): void => {
    void apiGet<DiscoveryReadResponse>(`/api/servers/${encodeURIComponent(serverId)}/discovery`).then((result) => {
      // Best-effort: a failed read leaves the section on whatever it last knew, matching every
      // other screen's own "resync never blocks the UI on a transient failure" precedent.
      if (!result.ok) return;
      setSettled({ collectedAt: result.data.collectedAt, checks: result.data.checks, warnings: result.data.warnings });
    });
  }, [serverId]);

  useEffect(() => {
    fetchSettled();
  }, [fetchSettled]);

  // Every reconnect resyncs from a fresh GET, exactly like the detail page's own server fetch
  // (05-UI-SPEC.md SS6 "Resync on reconnect") -- no event replay.
  useEffect(() => registerResync(fetchSettled), [registerResync, fetchSettled]);

  useEffect(() => {
    const previousStatus = previousStatusRef.current;
    previousStatusRef.current = serverStatus;

    if (serverStatus === 'CONNECTING') {
      setExpanded(true);
      return;
    }

    fetchSettled();
    if (previousStatus === 'CONNECTING') {
      // D-07: a run settles into a collapsed one-line summary, never staying expanded by default.
      setExpanded(false);
    }
  }, [serverStatus, fetchSettled]);

  // SS8: the live checklist is never itself one continuously-updating aria-live region (that would
  // announce every intermediate render) -- exactly one announcement fires per settled check,
  // through this dedicated hidden region instead.
  useEffect(() => {
    if (receivedChecks.length > previousReceivedCountRef.current) {
      const last = receivedChecks[receivedChecks.length - 1];
      if (last) {
        setAnnouncement(`${last.id.replace(/_/g, ' ')}: ${last.status.replace(/_/g, ' ')}`);
      }
    }
    previousReceivedCountRef.current = receivedChecks.length;
  }, [receivedChecks]);

  async function handleRerun(): Promise<void> {
    if (rerunPending) return;
    setRerunPending(true);
    setRerunError(null);

    const result = await apiSend('POST', `/api/servers/${encodeURIComponent(serverId)}/discover`);

    setRerunPending(false);
    // SS5.4/SS6: a 409 ALREADY_CONNECTING is a state confirmation, never a toast, matching
    // ServerDetailToolbar's own precedent for the identical rule.
    if (!result.ok && result.code !== 'ALREADY_CONNECTING') {
      setRerunError(isServiceErrorCode(result.code) ? copyForErrorCode(result.code) : result.message);
    }
  }

  const hasSettledHistory = settled !== null && settled.checks.length > 0;

  if (serverStatus !== 'CONNECTING' && !hasSettledHistory) {
    // Nothing has ever run -- 05-14's "Not discovered yet" empty state already owns this case; a
    // "0 of 0 passed" summary here would be meaningless, so this section renders nothing at all.
    return null;
  }

  const checklist = buildChecklist({ serverStatus, receivedChecks, settled: settled ?? EMPTY_SETTLED });
  const summaryText =
    serverStatus !== 'CONNECTING' && settled !== null
      ? `Discovered ${formatRelativeTime(settled.collectedAt, now)}, ${summarize(checklist)}`
      : null;

  return (
    <section aria-labelledby="discovery-section-title" className="flex flex-col gap-4">
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>

      <div className="flex items-center justify-between gap-4">
        <h2 id="discovery-section-title" className="text-title font-semibold text-ink">
          Discovery
        </h2>
        {serverStatus !== 'CONNECTING' ? (
          <Button
            type="button"
            variant="secondary"
            data-testid="discovery-rerun-button"
            disabled={serverStatus !== 'CONNECTED' || rerunPending}
            loading={rerunPending}
            onClick={() => void handleRerun()}
          >
            Re-run discovery
          </Button>
        ) : null}
      </div>

      {rerunError !== null ? <p className="text-caption text-status-error">{rerunError}</p> : null}

      {serverStatus === 'CONNECTING' ? <p className="text-caption text-ink-secondary">{IN_PROGRESS_CAPTION}</p> : null}

      {summaryText !== null ? (
        <button
          type="button"
          data-testid="discovery-summary"
          className="w-fit text-left text-callout text-ink-secondary hover:text-ink"
          onClick={() => {
            setExpanded((prev) => !prev);
          }}
        >
          {summaryText}
        </button>
      ) : null}

      {expanded ? (
        <div className="flex flex-col">
          {checklist.steps.map((step) => (
            <DiscoveryStep
              key={step.id}
              stepId={step.id}
              label={STEP_LABELS[step.id]}
              state={step.state}
              checks={step.checks}
              sshUser={sshUser}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}
