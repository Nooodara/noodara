// D-14 (05-UI-SPEC.md §2.6/§5.6) -- the activity log's own row: one sentence, a relative time
// with an ISO tooltip, `errorCode` in mono for failures only, and (only when the action has
// curated keys) a `Disclosure` revealing them. This component never composes its own prose or
// reads `item.metadata` directly -- every piece of text it renders comes from `sentenceFor`/
// `curatedDetailFor` (activity-copy.ts), the plan's own key_link and this screen's structural
// guarantee against ACT-02's T-5-64 (an unrecognised metadata key can never reach this row,
// because this component never even looks at `metadata` itself).
import { cn, Disclosure, LabelValue, RelativeTime } from '@noodara/ui';
import { curatedDetailFor, sentenceFor, type ActivityItem, type ActivityLookups, type ServerLookup } from '../lib/activity-copy';

// UI-07/D-11 (08-UI-SPEC.md §8.3, 08-16-PLAN.md Task 2): this screen's own one authored moment --
// a per-arrival entry, `translateY(4px)+opacity` over 200ms `--ease-out`, no stagger (deliberately
// different from the servers list's first-load stagger, §8.4). `ActivityList` computes `entering`
// (genuinely new since the previous render, never a "Load older" append), gated `motion-safe:` so
// reduced motion drops the transition and the row simply paints in its resting position.
const ENTERING_CLASSES =
  'motion-safe:transition-[opacity,transform] motion-safe:duration-[var(--duration-panel)] motion-safe:ease-[var(--ease-out)] motion-safe:starting:translate-y-1 motion-safe:starting:opacity-0';

export interface ActivityRowProps {
  readonly item: ActivityItem;
  /** The caller's own clock, explicit -- matches every other row/list component in this app
   *  (ServerRow, RelativeTime itself) so "as of" text is deterministic in tests. */
  readonly now: Date;
  readonly lookupServer: ServerLookup;
  /** Optional project/service lookups; without them those rows render plain text. */
  readonly lookups?: ActivityLookups;
  /** `ActivityList` gates this to a row genuinely new since its previous render -- never an
   *  initial load, never a "Load older" append. */
  readonly entering?: boolean;
}

// text-accent-text, not text-accent (05-45, decision D4): --accent as link text measured below
// 4.5:1 on --canvas/--surface-3 in light mode; --accent-text is the role-specific token that
// clears AA on every surface this link renders on, while --accent itself stays unchanged for
// outline/border/focus-ring use elsewhere.
const SERVER_LINK_CLASSES = 'text-accent-text hover:underline';
const SERVER_LINK_MONO_CLASSES = 'font-mono text-mono text-accent-text hover:underline';
const SERVER_TEXT_CLASSES = 'text-ink';
const SERVER_TEXT_MONO_CLASSES = 'font-mono text-mono text-ink';

export function ActivityRow({ item, now, lookupServer, lookups, entering = false }: ActivityRowProps) {
  const sentence = sentenceFor(item, lookupServer, lookups);
  const detail = curatedDetailFor(item);
  const hasDetail = detail.length > 0;

  return (
    <div
      data-testid="activity-row"
      data-entering={entering ? 'true' : undefined}
      className={cn('border-b border-hairline px-4 py-3', entering && ENTERING_CLASSES)}
    >
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
