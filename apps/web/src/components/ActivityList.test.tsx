// WR-B-06 (05-32-PLAN.md Task 3): activity-groups.test.ts's own two-zone cases already prove
// groupByDay is correct once given a real time zone -- the defect is confined to this component's
// caller-side `groupByDay(state.items, now)` call, which never passed one and so always fell back
// to activity-groups.ts's DEFAULT_TIME_ZONE ('UTC'). This test injects an explicit `timeZone` prop
// (the same seam `ServerFacts.test.tsx`/`ActivityRow.test.tsx` use for `now`) so the day header is
// asserted against a real non-UTC zone, deterministic regardless of the runner's own TZ.
import { describe, expect, it } from 'vitest';
import { renderUi, screen } from '@noodara/ui/testing';
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
