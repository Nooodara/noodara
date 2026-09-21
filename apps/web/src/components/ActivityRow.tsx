// D-14 (05-UI-SPEC.md §2.6/§5.6) -- the activity log's own row: one sentence, a relative time
// with an ISO tooltip, `errorCode` in mono for failures only, and (only when the action has
// curated keys) a `Disclosure` revealing them. This component never composes its own prose or
// reads `item.metadata` directly -- every piece of text it renders comes from `sentenceFor`/
// `curatedDetailFor` (activity-copy.ts), the plan's own key_link and this screen's structural
// guarantee against ACT-02's T-5-64 (an unrecognised metadata key can never reach this row,
// because this component never even looks at `metadata` itself).
import { Disclosure, LabelValue, RelativeTime } from '@noodara/ui';
import { curatedDetailFor, sentenceFor, type ActivityItem, type ServerLookup } from '../lib/activity-copy';

export interface ActivityRowProps {
  readonly item: ActivityItem;
  /** The caller's own clock, explicit -- matches every other row/list component in this app
   *  (ServerRow, RelativeTime itself) so "as of" text is deterministic in tests. */
  readonly now: Date;
  readonly lookupServer: ServerLookup;
}

// text-accent-text, not text-accent (05-45, decision D4): --accent as link text measured below
// 4.5:1 on --canvas/--surface-3 in light mode; --accent-text is the role-specific token that
// clears AA on every surface this link renders on, while --accent itself stays unchanged for
// outline/border/focus-ring use elsewhere.
const SERVER_LINK_CLASSES = 'text-accent-text hover:underline';
const SERVER_LINK_MONO_CLASSES = 'font-mono text-mono text-accent-text hover:underline';
const SERVER_TEXT_CLASSES = 'text-ink';
const SERVER_TEXT_MONO_CLASSES = 'font-mono text-mono text-ink';

export function ActivityRow({ item, now, lookupServer }: ActivityRowProps) {
  const sentence = sentenceFor(item, lookupServer);
  const detail = curatedDetailFor(item);
  const hasDetail = detail.length > 0;

  return (
    <div data-testid="activity-row" className="border-b border-hairline px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        <p className="min-w-0 flex-1 text-callout text-ink">
          {sentence.before}
          {sentence.server === null ? null : sentence.server.href !== null ? (
            <a href={sentence.server.href} className={sentence.server.mono ? SERVER_LINK_MONO_CLASSES : SERVER_LINK_CLASSES}>
              {sentence.server.label}
            </a>
          ) : (
            <span className={sentence.server.mono ? SERVER_TEXT_MONO_CLASSES : SERVER_TEXT_CLASSES}>{sentence.server.label}</span>
          )}
          {sentence.after}
        </p>
        <div className="flex shrink-0 items-center gap-3">
          {item.outcome === 'failure' && item.errorCode !== null ? (
            <span data-mono="true" className="font-mono text-mono text-status-error">
              {item.errorCode}
            </span>
          ) : null}
          <RelativeTime value={item.occurredAt} now={now} />
        </div>
      </div>
      {hasDetail ? (
        <Disclosure title="Details">
          <div className="pt-1">
            {detail.map((entry) => (
              <LabelValue key={entry.label} label={entry.label} value={entry.value} mono={entry.mono} />
            ))}
          </div>
        </Disclosure>
      ) : null}
    </div>
  );
}
