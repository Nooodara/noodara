// WR-B-06 (05-32-PLAN.md Task 3): activity-groups.test.ts's own two-zone cases already prove
// groupByDay is correct once given a real time zone -- the defect is confined to this component's
// caller-side `groupByDay(state.items, now)` call, which never passed one and so always fell back
// to activity-groups.ts's DEFAULT_TIME_ZONE ('UTC'). This test injects an explicit `timeZone` prop
// (the same seam `ServerFacts.test.tsx`/`ActivityRow.test.tsx` use for `now`) so the day header is
// asserted against a real non-UTC zone, deterministic regardless of the runner's own TZ.
import { describe, expect, it } from 'vitest';
import { renderUi, screen } from '@noodara/ui/testing';
import { TooltipProvider } from '@noodara/ui';
import { ActivityList, type ActivityListState } from './ActivityList';
import type { ActivityItem, ServerLookup } from '../lib/activity-copy';

const NOW = new Date('2026-03-15T12:00:00.000Z');
const EVENT_AT = '2026-03-15T02:30:00.000Z'; // 2026-03-14T20:30 in America/Mexico_City (UTC-6)

const notFoundLookup: ServerLookup = () => null;

function buildItem(overrides: Partial<ActivityItem> & Pick<ActivityItem, 'action'>): ActivityItem {
  return {
    id: 'evt-1',
    occurredAt: EVENT_AT,
    actorType: 'user',
    actorId: 'admin-1',
    entityType: 'session',
    entityId: null,
    outcome: 'success',
    errorCode: null,
    metadata: {},
    ...overrides,
  };
}

function readyState(item: ActivityItem): ActivityListState {
  return { kind: 'ready', items: [item], nextCursor: null, loadingMore: false, onLoadOlder: () => undefined };
}

function readyStateItems(
  items: readonly ActivityItem[],
  overrides: Partial<Extract<ActivityListState, { kind: 'ready' }>> = {},
): ActivityListState {
  return { kind: 'ready', items, nextCursor: null, loadingMore: false, onLoadOlder: () => undefined, ...overrides };
}

// 08-16-PLAN.md Task 2 (UI-07/D-11): the activity screen's own one authored moment is a per-arrival
// entry -- `translateY+opacity`, no stagger -- confined to genuinely new rows, never replayed on
// rows already on screen, and never applied to a "Load older" append (that is a page load, not an
// arrival). The merge-not-reset contract (older than this phase) is the regression this suite must
// keep proving: scroll position and already-loaded content survive an arrival, which this test
// verifies at the DOM level -- a preserved node identity (never remounted/re-keyed) is exactly what
// lets a real browser's own scroll position sit untouched.
describe('ActivityList arrival entry (UI-07/D-11, 08-16-PLAN.md Task 2)', () => {
  it('does not mark any row entering on the initial load -- that is a load, not an arrival', () => {
    const alpha = buildItem({ id: 'evt-alpha', action: 'auth.logout' });
    const beta = buildItem({ id: 'evt-beta', action: 'auth.logout' });

    renderUi(<ActivityList state={readyStateItems([alpha, beta])} now={NOW} lookupServer={notFoundLookup} timeZone="UTC" />);

    screen.getAllByTestId('activity-row').forEach((row) => {
      expect(row).not.toHaveAttribute('data-entering');
    });
  });

  it('marks only the genuinely new row entering when a refresh prepends it, leaving existing rows untouched (same DOM node, no replay)', () => {
    const alpha = buildItem({ id: 'evt-alpha', action: 'auth.logout' });
    const beta = buildItem({ id: 'evt-beta', action: 'auth.logout' });

    const result = renderUi(
      <ActivityList state={readyStateItems([alpha, beta])} now={NOW} lookupServer={notFoundLookup} timeZone="UTC" />,
    );

    const alphaRowBefore = screen.getAllByTestId('activity-row')[0];
    expect(screen.getAllByTestId('activity-row')).toHaveLength(2);

    const gamma = buildItem({ id: 'evt-gamma', action: 'auth.logout' });
    // `renderUi`'s own `TooltipProvider` must be re-supplied explicitly here -- RTL's `rerender`
    // replaces the tree it is given directly, dropping that outer wrapper (unlike
    // `options.wrapper`); `ActivityRow`'s `RelativeTime` needs it (ServerFacts.test.tsx's own
    // precedent for this exact idiom).
    result.rerender(
      <TooltipProvider delayDuration={0}>
        <ActivityList state={readyStateItems([gamma, alpha, beta])} now={NOW} lookupServer={notFoundLookup} timeZone="UTC" />
      </TooltipProvider>,
    );

    const rows = screen.getAllByTestId('activity-row');
    expect(rows).toHaveLength(3);
    const [gammaRow, alphaRowAfter, betaRow] = rows;
    expect(gammaRow).toHaveAttribute('data-entering', 'true');
    expect(alphaRowAfter).not.toHaveAttribute('data-entering');
    expect(betaRow).not.toHaveAttribute('data-entering');
    // The previously-rendered alpha row is the exact same DOM node -- never remounted, never
    // re-keyed -- which is what preserves a real browser's scroll position and focus across an
    // arrival.
    expect(alphaRowAfter).toBe(alphaRowBefore);
  });

  it('does not mark a "Load older" append entering -- appended rows are a page load, not an arrival', () => {
    const alpha = buildItem({ id: 'evt-alpha', action: 'auth.logout' });
    const beta = buildItem({ id: 'evt-beta', action: 'auth.logout' });

    const result = renderUi(
      <ActivityList state={readyStateItems([alpha, beta])} now={NOW} lookupServer={notFoundLookup} timeZone="UTC" />,
    );

    const gamma = buildItem({ id: 'evt-gamma', action: 'auth.logout' });
    result.rerender(
      <TooltipProvider delayDuration={0}>
        <ActivityList state={readyStateItems([alpha, beta, gamma])} now={NOW} lookupServer={notFoundLookup} timeZone="UTC" />
      </TooltipProvider>,
    );

    screen.getAllByTestId('activity-row').forEach((row) => {
      expect(row).not.toHaveAttribute('data-entering');
    });
  });

  it('keeps the entering row entering across an unrelated re-render (e.g. lookupServer resolving late) with the same items array -- 08-19 iteration-15 nightly flake (activity.spec.ts @activity-entry reduced-motion)', () => {
    const alpha = buildItem({ id: 'evt-alpha', action: 'auth.logout' });
    const gamma = buildItem({ id: 'evt-gamma', action: 'auth.logout' });

    const result = renderUi(<ActivityList state={readyStateItems([alpha])} now={NOW} lookupServer={notFoundLookup} timeZone="UTC" />);

    // Same array reference reused across both re-renders below -- the real page.tsx equivalent is
    // one `setState` call landing the arrival, whose resulting `items` array is stable until the
    // next fetch actually resolves.
    const arrivedItems = [gamma, alpha];
    result.rerender(
      <TooltipProvider delayDuration={0}>
        <ActivityList state={readyStateItems(arrivedItems)} now={NOW} lookupServer={notFoundLookup} timeZone="UTC" />
      </TooltipProvider>,
    );

    expect(screen.getAllByTestId('activity-row')[0]).toHaveAttribute('data-entering', 'true');

    // A parent re-render unrelated to activity data (ActivityPage's own `/api/servers` fetch
    // resolving after the arrival, or any other state change) passes ActivityList a brand-new
    // `lookupServer` identity but the *same* `items` array reference -- this must not clear the
    // entering flag, since nothing about the arrival itself has changed.
    const laterLookup: ServerLookup = () => null;
    result.rerender(
      <TooltipProvider delayDuration={0}>
        <ActivityList state={readyStateItems(arrivedItems)} now={NOW} lookupServer={laterLookup} timeZone="UTC" />
      </TooltipProvider>,
    );

    expect(screen.getAllByTestId('activity-row')[0]).toHaveAttribute('data-entering', 'true');
  });

  it('never staggers the arrival entrance -- no per-item transitionDelay on the newly entering row', () => {
    const alpha = buildItem({ id: 'evt-alpha', action: 'auth.logout' });

    const result = renderUi(<ActivityList state={readyStateItems([alpha])} now={NOW} lookupServer={notFoundLookup} timeZone="UTC" />);

    const beta = buildItem({ id: 'evt-beta', action: 'auth.logout' });
    result.rerender(
      <TooltipProvider delayDuration={0}>
        <ActivityList state={readyStateItems([beta, alpha])} now={NOW} lookupServer={notFoundLookup} timeZone="UTC" />
      </TooltipProvider>,
    );

    const enteringRow = screen.getAllByTestId('activity-row')[0];
    expect(enteringRow).toHaveAttribute('data-entering', 'true');
    expect(enteringRow?.getAttribute('style') ?? '').not.toContain('transition-delay');
  });
});

describe('ActivityList -- day headers follow the viewer time zone prop, never a UTC default (WR-B-06)', () => {
  it('renders TODAY when the injected timeZone is UTC', () => {
    const item = buildItem({ action: 'auth.logout' });
    renderUi(<ActivityList state={readyState(item)} now={NOW} lookupServer={notFoundLookup} timeZone="UTC" />);

    expect(screen.getByText('TODAY')).toBeInTheDocument();
    expect(screen.queryByText('YESTERDAY')).not.toBeInTheDocument();
  });

  it('renders YESTERDAY for the exact same item+now pair when the injected timeZone is America/Mexico_City (UTC-6)', () => {
    const item = buildItem({ action: 'auth.logout' });
    renderUi(<ActivityList state={readyState(item)} now={NOW} lookupServer={notFoundLookup} timeZone="America/Mexico_City" />);

    expect(screen.getByText('YESTERDAY')).toBeInTheDocument();
    expect(screen.queryByText('TODAY')).not.toBeInTheDocument();
  });
});
