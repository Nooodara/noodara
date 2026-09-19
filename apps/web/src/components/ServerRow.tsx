// The D-09 servers-list row (05-UI-SPEC.md SS2.3): a 44px hairline row -- name, host:port in
// mono, a StatusPill and a relative last-seen with its own ISO tooltip. The whole row is a real
// link to `/servers/{id}` (built on `ListRow`'s own `href` activation, never a `<div>` click
// handler), so click and keyboard activation are entirely native. `RowMenu`'s "Edit"/"Delete"
// handlers are props this plan wires to no-ops (see below) -- Plan 05-17 connects the real edit
// sheet and the destructive delete confirm dialog.
//
// Wrapped in its own `data-testid="servers-row"`/`data-server-name` div rather than adding those
// two attributes to `ListRow` itself: `ListRow` is a shared primitive every list this phase needs
// (servers today, activity later, per 05-UI-SPEC.md's Component Inventory), so a server-specific
// attribute does not belong on its own props -- this thin wrapper keeps that primitive generic
// while still giving Playwright a stable, order-independent row handle (05-UI-SPEC.md SS9).
import { ListRow, RelativeTime, RowMenu, StatusPill } from '@noodara/ui';
import type { ServerView } from '../lib/api-client';

export interface ServerRowProps {
  readonly server: ServerView;
  /** The caller's own clock, explicit -- matches `RelativeTime`'s own no-platform-clock
   *  discipline so this row's "as of" text is deterministic in tests. */
  readonly now: Date;
  readonly onEdit: (server: ServerView) => void;
  readonly onDelete: (server: ServerView) => void;
}

export function ServerRow({ server, now, onEdit, onDelete }: ServerRowProps) {
  return (
    <div data-testid="servers-row" data-server-name={server.name}>
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
