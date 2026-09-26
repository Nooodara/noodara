// The D-09 servers-list row (05-UI-SPEC.md SS2.3): a 44px hairline row -- name, host:port in
// mono, a StatusPill and a relative last-seen with its own ISO tooltip. The whole row is a real
// link to `/servers/{id}` (built on `ListRow`'s own `href` activation, never a `<div>` click
// handler), so click and keyboard activation are entirely native. `RowMenu`'s "Edit"/"Delete"
// handlers are required props -- 05-17-PLAN.md wires them to the real edit sheet and the
// destructive delete confirm dialog via `ServerList`/`(shell)/servers/page.tsx`.
//
// Wrapped in its own `data-testid="servers-row"`/`data-server-name` div rather than adding those
// two attributes to `ListRow` itself: `ListRow` is a shared primitive every list this phase needs
// (servers today, activity later, per 05-UI-SPEC.md's Component Inventory), so a server-specific
// attribute does not belong on its own props -- this thin wrapper keeps that primitive generic
// while still giving Playwright a stable, order-independent row handle (05-UI-SPEC.md SS9).
import { cn, ListRow, RelativeTime, RowMenu, StatusPill } from '@noodara/ui';
import type { ServerView } from '../lib/api-client';

// UI-07 (08-UI-SPEC.md §7.4/§8.3, D-11, 08-16-PLAN.md Task 1): the servers list's own one
// authored moment is a stagger on first load only -- `translateY(4px)+opacity` over 200ms
// `--ease-out`, `ServerList`'s own per-row delay already computed and capped there. Gated
// `motion-safe:` (UI-10 -- reduced motion drops the transition entirely, so the `starting:`
// state never has anything to animate from and the row simply paints in its resting position).
// Never `pointer-events-none` anywhere in this rule -- every row stays clickable from the first
// frame of the stagger (§9's "never block interaction during a transition").
const ENTERING_CLASSES =
  'motion-safe:transition-[opacity,transform] motion-safe:duration-[var(--duration-panel)] motion-safe:ease-[var(--ease-out)] motion-safe:starting:translate-y-1 motion-safe:starting:opacity-0';

export interface ServerRowProps {
  readonly server: ServerView;
  /** The caller's own clock, explicit -- matches `RelativeTime`'s own no-platform-clock
   *  discipline so this row's "as of" text is deterministic in tests. */
  readonly now: Date;
  readonly onEdit: (server: ServerView) => void;
  readonly onDelete: (server: ServerView) => void;
  /** This row's already-computed, already-capped first-load stagger delay in ms (`ServerList`'s
   *  own `rowStaggerDelayMs(index)` -- the 40ms-per-index math lives there, the single source of
   *  truth for the stagger, not duplicated on this purely presentational row). */
  readonly delayMs: number;
  /** `ServerList` gates this to the single render that first has data -- a later re-render (or a
   *  server added afterwards) passes `false`, so the entrance never replays. */
  readonly entering: boolean;
}

export function ServerRow({ server, now, onEdit, onDelete, delayMs, entering }: ServerRowProps) {
  return (
    <div
      data-testid="servers-row"
      data-server-name={server.name}
      data-entering={entering ? 'true' : undefined}
      className={cn(entering && ENTERING_CLASSES)}
      style={entering ? { transitionDelay: `${String(delayMs)}ms` } : undefined}
    >
      <ListRow
        href={`/servers/${server.id}`}
        primaryText={server.name}
        secondary={
          <span className="flex items-center gap-3">
            <span className="text-mono">{`${server.host}:${String(server.sshPort)}`}</span>
            <StatusPill status={server.status} />
          </span>
        }
        trailing={
          <span className="flex items-center gap-2">
            <RelativeTime value={server.lastSeenAt} now={now} />
            <RowMenu
              triggerLabel={`Actions for ${server.name}`}
              items={[
                {
                  label: 'Edit',
                  onSelect: () => {
                    onEdit(server);
                  },
                },
                {
                  label: 'Delete',
                  destructive: true,
                  onSelect: () => {
                    onDelete(server);
                  },
                },
              ]}
            />
          </span>
        }
      />
    </div>
  );
}
