// The pure snapshot-vs-event reconciliation guard behind the server detail screen's single write
// path (05-VERIFICATION.md gap 2 / SC2, DETL-01/DETL-02, 05-29-PLAN.md Task 2). Mirrors
// `(shell)/servers/page.tsx`'s own `reconcileSnapshot` precedent (an ordinary GET racing a live
// event must never regress the screen) but as a single-entity decision function rather than a
// list fold, since the detail page has exactly one server to guard, not a list to merge events
// onto. Pure: no refs, no setState, no clock read, no `fetch`, no `EventSource` -- the caller
// (`servers/[id]/page.tsx`) owns every ref (`latestRequestRef`, `deletedRef`) and every network
// call; this module only ever decides accept/reject from values already in hand.
export interface DetailSnapshotLike {
  readonly updatedAt: string;
}

export type DetailSyncSource = 'snapshot' | 'event';

export type ReconcileDetailReason = 'deleted' | 'superseded-request' | 'stale-snapshot';

export type ReconcileDetailDecision =
  | { readonly accept: true }
  | { readonly accept: false; readonly reason: ReconcileDetailReason };

export interface ReconcileDetailSnapshotInput<T extends DetailSnapshotLike> {
  /** The server currently displayed, or `null` before the first successful load for this mount. */
  readonly held: T | null;
  /** The value under consideration -- a `GET` response body (`source: 'snapshot'`) or an SSE
   *  `server.updated` payload (`source: 'event'`). */
  readonly incoming: T;
  readonly source: DetailSyncSource;
  /** `deletedRef.current` -- true once a `server.deleted` event has been observed for this server
   *  id during this mount. Never unset for the mount's lifetime (the caller's own invariant); this
   *  function just refuses to accept anything, from either source, once it is true, so nothing can
   *  resurrect a server the page has already learned is gone. */
  readonly isDeleted: boolean;
  /** Only meaningful for `source === 'snapshot'`: the sequence number of the `GET` request that
   *  produced `incoming` (`latestRequestRef`'s value at the moment that request was issued).
   *  `null` for `source === 'event'` -- events carry no request sequence and are never subject to
   *  the supersede check below. */
  readonly requestSequence: number | null;
  /** The most recently issued `GET` request's own sequence number. A `requestSequence` below this
   *  means a newer `GET` has already been issued (and will resolve, or has already resolved) since
   *  this one was sent -- this one is superseded and must never win a race against it. */
  readonly latestRequestSequence: number;
}

/**
 * Decides whether `incoming` should replace `held` as the server detail screen's displayed state.
 *
 * - `isDeleted` always wins first: once true, everything is rejected regardless of source or
 *   `updatedAt` -- a subsequent `GET` (even one issued before the deletion was learned, resolving
 *   late) can never resurrect the row (DETL-01/DETL-02 truth: "a GET that races a live
 *   server.updated or server.deleted cannot leave the page ... resurrect a deleted server").
 * - `source === 'snapshot'`: rejected if its own request was superseded by a newer one, or if
 *   `held` is strictly newer (`updatedAt`) than `incoming` -- an ordinary GET racing a live event
 *   must never roll the screen back to older data.
 * - `source === 'event'`: always accepted once `isDeleted` is false. Events are the live source of
 *   truth; the staleness guard exists only to stop a stale `GET` from overwriting a fresh event,
 *   never the reverse (a `server.updated` frame is never older than what produced it).
 */
export function reconcileDetailSnapshot<T extends DetailSnapshotLike>(
  input: ReconcileDetailSnapshotInput<T>,
): ReconcileDetailDecision {
  const { held, incoming, source, isDeleted, requestSequence, latestRequestSequence } = input;

  if (isDeleted) {
    return { accept: false, reason: 'deleted' };
  }

  if (source === 'snapshot') {
    if (requestSequence !== null && requestSequence !== latestRequestSequence) {
      return { accept: false, reason: 'superseded-request' };
    }
    if (held !== null && Date.parse(held.updatedAt) > Date.parse(incoming.updatedAt)) {
      return { accept: false, reason: 'stale-snapshot' };
    }
  }

  return { accept: true };
}
