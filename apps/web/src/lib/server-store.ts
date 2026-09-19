// The pure list reducer behind the servers screen (05-13-PLAN.md Task 1, 05-UI-SPEC.md SS6 "no
// rebuild-from-scratch re-render of the row"). No fetching, no React, no clock -- `applyServerEvent`
// folds one `ServerEvent` (05-12's `server-events.ts`) onto the current list, always returning the
// original array reference when nothing changed so a caller (Task 2's page.tsx) can skip a
// re-render cheaply, and always keeping every untouched entry's own object identity so a patched
// row never causes a sibling row to re-render.
import type { ServerView } from './api-client';
import type { ServerEvent } from './server-events';

/** Case-insensitive comparison so "Alpha" and "alpha" sort adjacently, matching the server's own
 *  `lower(name)` unique index (apps/control-plane/src/services/read-servers.ts) -- a live insert
 *  must land exactly where a full refetch would put it. */
function compareServerNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base' });
}

/** Every server ordered by name, case-insensitively -- the same order `listServerViews` returns
 *  from the API, so the initial fetch and every subsequent live insert agree on placement. */
export function sortServers(list: readonly ServerView[]): ServerView[] {
  return [...list].sort((a, b) => compareServerNames(a.name, b.name));
}

function insertSorted(list: readonly ServerView[], server: ServerView): ServerView[] {
  const next = [...list];
  let index = next.findIndex((entry) => compareServerNames(entry.name, server.name) > 0);
  if (index === -1) {
    index = next.length;
  }
  next.splice(index, 0, server);
  return next;
}

/**
 * Folds one `ServerEvent` onto `list`:
 * - `server.updated` for a known id replaces that entry in place (every other entry's array slot
 *   -- and therefore object reference -- is untouched).
 * - `server.updated` for an unknown id inserts the server at its correct sorted position.
 * - `server.deleted` for a known id removes it; for an unknown id returns `list` itself unchanged.
 * - `server.discovery_progress` is ignored here (the detail screen owns it) and returns `list`
 *   itself unchanged.
 */
export function applyServerEvent(list: readonly ServerView[], event: ServerEvent): readonly ServerView[] {
  switch (event.type) {
    case 'server.updated': {
      const index = list.findIndex((entry) => entry.id === event.server.id);
      if (index === -1) {
        return insertSorted(list, event.server);
      }
      const next = [...list];
      next[index] = event.server;
      return next;
    }
    case 'server.deleted': {
      const index = list.findIndex((entry) => entry.id === event.id);
      if (index === -1) {
        return list;
      }
      const next = [...list];
      next.splice(index, 1);
      return next;
    }
    case 'server.discovery_progress': {
      return list;
    }
    default: {
      return list;
    }
  }
}

/**
 * Folds the events that arrived while a `GET /api/servers` snapshot was in flight onto that
 * snapshot, in arrival order. There is no event replay (05-UI-SPEC.md SS6), so an event delivered
 * during a fetch is either already reflected in the snapshot or strictly newer than it -- and the
 * screen cannot tell which from timing alone:
 *
 * - `server.updated` for an id the snapshot lacks was created after the snapshot was read: insert.
 * - `server.updated` for a known id is applied unless the snapshot's own entry is strictly newer
 *   (`updatedAt`, which every server write bumps) -- an event the snapshot already superseded must
 *   never regress the row back to an older version.
 * - `server.deleted` always applies: a server id is never reused, so a deletion can only ever be
 *   newer than any snapshot that still lists it.
 *
 * Returns `snapshot` itself when nothing was buffered.
 */
export function reconcileSnapshot(snapshot: readonly ServerView[], events: readonly ServerEvent[]): readonly ServerView[] {
  let list = snapshot;
  for (const event of events) {
    if (event.type === 'server.updated') {
      const known = list.find((entry) => entry.id === event.server.id);
      if (known !== undefined && Date.parse(known.updatedAt) > Date.parse(event.server.updatedAt)) {
        continue;
      }
    }
    list = applyServerEvent(list, event);
  }
  return list;
}
