'use client';

// The server detail screen (DETL-01/DETL-02/D-10/D-11/D-12, 05-UI-SPEC.md SS2.5) -- its own page
// at /servers/:id. Fetches the real server, subscribes to the shared SSE stream for this one id,
// and renders exactly one of five states via `deriveDetailState`
// (apps/web/src/lib/detail-state.ts): `never-discovered`/`failed-no-history`/`failed-with-
// history`/`discovered`/`host-key-changed`.
//
// One surface from 05-UI-SPEC.md SS2.5's own layout is deliberately left as a documented seam,
// never even a stubbed empty section, matching D-05's "never invent progress" discipline extended
// to every not-yet-built part of this page:
//   - The first-trust notice (layout position 1) and the real `HOST_KEY_CHANGED` banner + trust
//     dialog (D-02/D-03) -- Plan 05-19. This plan renders only a neutral placeholder block for the
//     `host-key-changed` detail state, named for that plan.
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
import { ServerDetailToolbar } from '../../../../components/ServerDetailToolbar';
import { ServerFacts } from '../../../../components/ServerFacts';
import { apiGet, type ApiErrorCode, type ServerView } from '../../../../lib/api-client';
import { deriveDetailState, derivePrimaryAction } from '../../../../lib/detail-state';
import { copyForErrorCode, copyForServerErrorCode } from '../../../../lib/error-copy';
import { requireSession } from '../../../../lib/require-session';
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
  // `DiscoverySection` itself) and cleared the instant a new run starts -- detected below as a
  // transition into `CONNECTING` for this same server id.
  const [liveChecks, setLiveChecks] = useState<readonly DiscoveryCheck[]>([]);
  const previousStatusRef = useRef<ServerView['status'] | null>(null);

  const fetchServer = useCallback((): void => {
    if (!hasLoadedRef.current) {
      setState({ kind: 'loading' });
    }

    void apiGet<ServerView>(`/api/servers/${encodeURIComponent(id)}`).then((result) => {
      if (!result.ok) {
        if (result.unauthorized) {
          // The shell's own session guard owns the redirect -- this screen never navigates to
          // /login itself (matches (shell)/servers/page.tsx's own precedent).
          void requireSession();
          return;
        }
        if (result.code === 'NOT_FOUND') {
          setState({ kind: 'not-found' });
          return;
        }
        setState({ kind: 'error', message: genericFailureMessage(result.code, result.message), code: result.code });
        return;
      }

      hasLoadedRef.current = true;
      previousStatusRef.current = result.data.status;
      setState({ kind: 'ready', server: result.data });
    });
  }, [id]);

  useEffect(() => {
    hasLoadedRef.current = false;
    previousStatusRef.current = null;
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
          hasLoadedRef.current = true;
          if (previousStatusRef.current !== 'CONNECTING' && event.server.status === 'CONNECTING') {
            // A new run just started -- discard whatever the previous run's live progress was.
            setLiveChecks([]);
          }
          previousStatusRef.current = event.server.status;
          setState({ kind: 'ready', server: event.server });
        }
        if (event.type === 'server.deleted' && event.id === id) {
          setState({ kind: 'not-found' });
        }
        if (event.type === 'server.discovery_progress' && event.serverId === id) {
          setLiveChecks((prev) => (prev.some((check) => check.id === event.check.id) ? prev : [...prev, event.check]));
        }
      }),
    [subscribe, id],
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
        <Link href="/servers" className="text-callout text-accent hover:underline">
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
        {/* Plan 05-19 mounts the first-trust notice here (05-UI-SPEC.md SS2.5 layout position 1)
            and replaces the HOST_KEY_CHANGED placeholder immediately below with the real SS5.3
            banner and trust-new-fingerprint dialog. */}
        {detailState === 'host-key-changed' ? (
          <div
            data-testid="server-detail-host-key-changed-placeholder"
            className="flex flex-col gap-2 rounded-md border border-hairline bg-surface-1 px-5 py-4"
          >
            <p className="text-body text-ink">
              This server&apos;s host key changed since it was last trusted. Verify it before continuing.
            </p>
            <span data-mono="true" className="text-mono text-ink-tertiary">
              HOST_KEY_CHANGED
            </span>
          </div>
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
    </>
  );
}
