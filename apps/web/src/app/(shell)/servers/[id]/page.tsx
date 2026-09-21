'use client';

// The server detail screen (DETL-01/DETL-02/D-10/D-11/D-12, 05-UI-SPEC.md SS2.5) -- its own page
// at /servers/:id. Fetches the real server, subscribes to the shared SSE stream for this one id,
// and renders exactly one of five states via `deriveDetailState`
// (apps/web/src/lib/detail-state.ts): `never-discovered`/`failed-no-history`/`failed-with-
// history`/`discovered`/`host-key-changed`.
//
// 05-19-PLAN.md wires D-02/D-03 in at this page's two remaining documented seams: the first-trust
// notice (layout position 1, gated by apps/web/src/lib/first-trust.ts's
// shouldShowFirstTrustNotice) and the real HOST_KEY_CHANGED banner + type-the-name trust dialog
// (layout position 2, replacing Plan 05-14's neutral placeholder for the `host-key-changed` detail
// state). Both are the TOFU-critical surfaces (05-01-SUMMARY.md's UF-01 finding is exactly what
// this trust path has to defend against) -- see HostKeyChangedBanner.tsx/TrustFingerprintDialog.tsx
// for the full security contract.
//
// The Discovery section (layout position 6, DISC-02/D-05..D-08) is wired in by this plan: this
// page owns accumulating `server.discovery_progress` events for this server id (the live progress
// `DiscoverySection` renders through `buildChecklist`), clearing that accumulator the instant a
// new run starts (a transition into `CONNECTING`) -- `DiscoverySection` itself never reads the SSE
// stream directly, only the checks this page hands it.
//
// `[id]` is an untrusted route param: every use in an API path goes through
// `encodeURIComponent`, and an unknown/malformed id renders the same `NOT_FOUND` "This server no
// longer exists." state as a deleted one, never a raw error dump (05-UI-SPEC.md SS10).
import { use, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { DiscoveryCheck } from '@noodara/domain/discovery';
import type { ServerErrorCode } from '@noodara/domain/server';
import { Banner, EmptyState, Skeleton, SkeletonText } from '@noodara/ui';
import { DiscoverySection } from '../../../../components/DiscoverySection';
import { FirstTrustNotice } from '../../../../components/FirstTrustNotice';
import { HostKeyChangedBanner } from '../../../../components/HostKeyChangedBanner';
import { ServerDetailToolbar } from '../../../../components/ServerDetailToolbar';
import { ServerFacts } from '../../../../components/ServerFacts';
import { TrustFingerprintDialog } from '../../../../components/TrustFingerprintDialog';
import { apiGet, type ApiErrorCode, type ServerView } from '../../../../lib/api-client';
import { reconcileDetailSnapshot } from '../../../../lib/detail-sync';
import { deriveDetailState, derivePrimaryAction } from '../../../../lib/detail-state';
import { copyForErrorCode, copyForServerErrorCode } from '../../../../lib/error-copy';
import { dismissFirstTrustNotice, shouldShowFirstTrustNotice } from '../../../../lib/first-trust';
import { requireSession } from '../../../../lib/require-session';
import { safeLocalStorage } from '../../../../lib/safe-storage';
import { useShellContext } from '../../../../lib/shell-context';

type PageState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'error'; readonly message: string; readonly code: string }
  | { readonly kind: 'ready'; readonly server: ServerView };

// Matches `(shell)/servers/page.tsx`'s own established precedent for this exact code.
function genericFailureMessage(code: ApiErrorCode, message: string): string {
  if (code === 'NETWORK_ERROR') return message;
  return copyForErrorCode(code);
}

/** Narrows `lastErrorCode` to the subset `copyForServerErrorCode` accepts -- `null` and
 *  `HOST_KEY_CHANGED` (which throws there by design, SS5.1) never reach that call. */
function isGenericServerErrorCode(
  code: ServerView['lastErrorCode'],
): code is Exclude<NonNullable<ServerView['lastErrorCode']>, 'HOST_KEY_CHANGED'> {
  return code !== null && code !== 'HOST_KEY_CHANGED';
}

interface ServerDetailPageProps {
  readonly params: Promise<{ readonly id: string }>;
}

function DetailSkeleton() {
  return (
    <div className="mx-auto flex max-w-[1120px] flex-col gap-8 p-8">
      <div data-testid="server-detail-skeleton-tiles" className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} width="100%" height={104} />
        ))}
      </div>
      <div data-testid="server-detail-skeleton-rows" className="flex flex-col gap-3">
        {[0, 1, 2, 3, 4, 5].map((index) => (
          <SkeletonText key={index} />
        ))}
      </div>
    </div>
  );
}

export default function ServerDetailPage({ params }: ServerDetailPageProps) {
  const { id } = use(params);
  const { subscribe, registerResync } = useShellContext();
  const [state, setState] = useState<PageState>({ kind: 'loading' });
  // First-load-only skeleton (05-UI-SPEC.md SS2.5's loading rule): an event-driven update later
  // must patch in place, never re-skeletonize an already-visible screen.
  const hasLoadedRef = useRef(false);
  // DISC-02/D-05: this run's `server.discovery_progress` checks, accumulated here (never inside
  // `DiscoverySection` itself) and cleared on every transition into OR out of `CONNECTING` --
  // detected below in `applyServer`'s shared status-transition handler, whether the transition was
  // learned from a `GET` snapshot or an SSE event (05-VERIFICATION.md gap 3 finding: only the SSE
  // branch used to clear it, and only on the into-CONNECTING direction).
  const [liveChecks, setLiveChecks] = useState<readonly DiscoveryCheck[]>([]);
  // 05-VERIFICATION.md gap 2 / SC2 (DETL-01/DETL-02): the currently displayed server, mirrored
  // here so `applyServer` always reconciles against the live value, never a stale render closure.
  // `latestRequestRef` makes only the newest issued GET allowed to publish (a superseded GET whose
  // response resolves late is dropped outright); `deletedRef` is set once by `server.deleted` and
  // never unset for this mount, so no later GET -- however it resolves -- can resurrect the row.
  const heldServerRef = useRef<ServerView | null>(null);
  const latestRequestRef = useRef(0);
  const deletedRef = useRef(false);
  // D-02: a dismissal is client-side, cosmetic state read fresh on every render via
  // first-trust.ts's own shouldShowFirstTrustNotice/dismissFirstTrustNotice -- this setter only
  // forces a re-render after a click so the notice disappears immediately; the counter's value
  // itself is never read, storage is always the source of truth.
  const [, setDismissTick] = useState(0);
  // D-03: the trust-new-fingerprint dialog's own open state, owned by this page (matching
  // ServersPage's own sheet/dialog ownership precedent) since it must survive independently of
  // whichever detail state is currently rendered underneath it.
  const [trustDialogOpen, setTrustDialogOpen] = useState(false);

  // The one write path onto `state: { kind: 'ready' }` (05-VERIFICATION.md gap 2 / SC2) -- every
  // writer (`fetchServer`'s success, the resync path it shares, `server.updated`) calls this
  // instead of `setState` directly. `reconcileDetailSnapshot` is the pure decision;
  // `latestRequestRef`/`deletedRef`/`heldServerRef` are the only refs it needs, all owned here.
  const applyServer = useCallback(
    (next: ServerView, source: 'snapshot' | 'event', requestSequence: number | null): void => {
      const decision = reconcileDetailSnapshot({
        held: heldServerRef.current,
        incoming: next,
        source,
        isDeleted: deletedRef.current,
        requestSequence,
        latestRequestSequence: latestRequestRef.current,
      });
      if (!decision.accept) {
        return;
      }

      const previousStatus = heldServerRef.current?.status ?? null;
      const enteringConnecting = previousStatus !== 'CONNECTING' && next.status === 'CONNECTING';
      const leavingConnecting = previousStatus === 'CONNECTING' && next.status !== 'CONNECTING';
      if (enteringConnecting || leavingConnecting) {
        // A run just started or just ended -- discard whatever live progress belonged to it, from
        // either direction, so a finished run's checks can never render as the next run's.
        setLiveChecks([]);
      }

      heldServerRef.current = next;
      hasLoadedRef.current = true;
      setState({ kind: 'ready', server: next });
    },
    [],
  );

  const fetchServer = useCallback((): void => {
    if (!hasLoadedRef.current) {
      setState({ kind: 'loading' });
    }

    latestRequestRef.current += 1;
    const requestSequence = latestRequestRef.current;

    void apiGet<ServerView>(`/api/servers/${encodeURIComponent(id)}`).then((result) => {
      if (!result.ok && result.unauthorized) {
        // The shell's own session guard owns the redirect -- this screen never navigates to
        // /login itself (matches (shell)/servers/page.tsx's own precedent).
        void requireSession();
        return;
      }
      if (requestSequence !== latestRequestRef.current) {
        // Superseded by a newer GET already issued for this id -- dropped unconditionally,
        // success or failure, so an older request resolving late can never win a race.
        return;
      }
      if (deletedRef.current) {
        // Already known deleted (a real `server.deleted` arrived) -- nothing a late-resolving GET
        // says can move this screen off "This server no longer exists.".
        return;
      }

      if (!result.ok) {
        if (result.code === 'NOT_FOUND') {
          setState({ kind: 'not-found' });
          return;
        }
        setState({ kind: 'error', message: genericFailureMessage(result.code, result.message), code: result.code });
        return;
      }

      applyServer(result.data, 'snapshot', requestSequence);
    });
  }, [id, applyServer]);

  useEffect(() => {
    hasLoadedRef.current = false;
    heldServerRef.current = null;
    deletedRef.current = false;
    setLiveChecks([]);
    fetchServer();
  }, [fetchServer]);

  // Every reconnect resyncs from a fresh GET, exactly like a normal page load -- no event replay
  // (05-UI-SPEC.md SS6 "Resync on reconnect").
  useEffect(() => registerResync(fetchServer), [registerResync, fetchServer]);

  useEffect(
    () =>
      subscribe((event) => {
        if (event.type === 'server.updated' && event.server.id === id) {
          applyServer(event.server, 'event', null);
        }
        if (event.type === 'server.deleted' && event.id === id) {
          deletedRef.current = true;
          heldServerRef.current = null;
          setState({ kind: 'not-found' });
        }
        if (event.type === 'server.discovery_progress' && event.serverId === id) {
          setLiveChecks((prev) => (prev.some((check) => check.id === event.check.id) ? prev : [...prev, event.check]));
        }
      }),
    [subscribe, id, applyServer],
  );

  if (state.kind === 'loading') {
    return <DetailSkeleton />;
  }

  if (state.kind === 'not-found') {
    return (
      <div className="mx-auto flex max-w-[1120px] flex-col items-start gap-2 p-8">
        <p data-testid="server-detail-not-found" className="text-body text-ink">
          This server no longer exists.
        </p>
        {/* text-accent-text, not text-accent (05-45, decision D4) -- see ActivityRow.tsx's
            identical comment for the full rationale. */}
        <Link href="/servers" className="text-callout text-accent-text hover:underline">
          Back to Servers
        </Link>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div className="mx-auto max-w-[1120px] p-8">
        <Banner
          data-testid="server-detail-error-banner"
          message={state.message}
          errorCode={state.code}
          action={{ label: 'Retry', onClick: fetchServer }}
        />
      </div>
    );
  }

  const { server } = state;
  const now = new Date();
  const detailState = deriveDetailState(server);
  const primaryAction = derivePrimaryAction(server);
  const warnings: readonly ServerErrorCode[] = server.lastErrorCode === 'UNSUPPORTED_OS' ? ['UNSUPPORTED_OS'] : [];

  return (
    <>
      <ServerDetailToolbar
        serverId={server.id}
        serverName={server.name}
        status={server.status}
        primaryAction={primaryAction}
        onActionSettled={fetchServer}
      />
      <div className="mx-auto flex max-w-[1120px] flex-col gap-8 p-8">
        {/* D-02, 05-UI-SPEC.md SS2.5 layout position 1 -- shown once per server, gated on
            `safeLocalStorage()` (T-5G-29-05: a blocked/unavailable storage backend degrades to
            "show the notice", never throws through render; see first-trust.test.ts for the
            storage-injected pure logic this reads). Recomputed fresh on every render --
            `setDismissTick` above only exists to trigger the re-render after a click. */}
        {shouldShowFirstTrustNotice(safeLocalStorage(), server.id, server.hostFingerprintCapturedAt) &&
        server.hostFingerprint !== null ? (
          <FirstTrustNotice
            fingerprint={server.hostFingerprint}
            onDismiss={() => {
              dismissFirstTrustNotice(safeLocalStorage(), server.id);
              setDismissTick((tick) => tick + 1);
            }}
          />
        ) : null}

        {/* D-03, 05-UI-SPEC.md SS2.5 layout position 2 -- the dedicated banner replaces the
            generic DETL-02 banner entirely for this one code; the two are never rendered
            together (see the `failed-*` branch immediately below, which only fires for every
            other ServerErrorCode). */}
        {detailState === 'host-key-changed' ? (
          <HostKeyChangedBanner
            host={server.host}
            sshPort={server.sshPort}
            hostFingerprint={server.hostFingerprint}
            hostFingerprintCapturedAt={server.hostFingerprintCapturedAt}
            pendingFingerprint={server.pendingFingerprint}
            pendingFingerprintSeenAt={server.pendingFingerprintSeenAt}
            now={now}
            onTrustClick={() => {
              setTrustDialogOpen(true);
            }}
          />
        ) : null}

        {(detailState === 'failed-no-history' || detailState === 'failed-with-history') &&
        isGenericServerErrorCode(server.lastErrorCode) ? (
          <Banner
            data-testid="server-detail-error-banner"
            message={copyForServerErrorCode(server.lastErrorCode, { host: server.host, sshPort: server.sshPort })}
            errorCode={server.lastErrorCode}
          />
        ) : null}

        {detailState === 'never-discovered' || detailState === 'failed-no-history' ? (
          <EmptyState data-testid="server-detail-empty" title="Not discovered yet." body="" />
        ) : null}

        {detailState === 'discovered' || detailState === 'failed-with-history' ? (
          <ServerFacts server={server} now={now} dimmed={detailState === 'failed-with-history'} warnings={warnings} />
        ) : null}

        {detailState === 'host-key-changed' ? (
          server.hostname !== null ? (
            <ServerFacts server={server} now={now} dimmed warnings={[]} />
          ) : (
            <EmptyState data-testid="server-detail-empty" title="Not discovered yet." body="" />
          )
        ) : null}

        <DiscoverySection
          serverId={server.id}
          serverStatus={server.status}
          sshUser={server.sshUser}
          receivedChecks={liveChecks}
          now={now}
        />
      </div>
      <TrustFingerprintDialog
        open={trustDialogOpen}
        onOpenChange={setTrustDialogOpen}
        server={server}
        onSettled={fetchServer}
        now={now}
      />
    </>
  );
}
