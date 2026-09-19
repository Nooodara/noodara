// D-13 (05-UI-SPEC.md §2.6) -- pure day grouping and page merging for the activity log's cursor
// pagination. No React, no fetch, no platform clock: `groupByDay`'s reference date and time zone
// are always caller-supplied, exactly like `packages/domain`'s own `now: Date` discipline and
// `packages/ui/src/format.ts`'s `formatRelativeTime`. Deterministic across the host's own
// TZ/locale -- every calendar computation below goes through `Intl.DateTimeFormat` with an
// explicit `timeZone`, never the runner's own default.

export interface DayGroup<T> {
  readonly label: string;
  readonly items: readonly T[];
}

interface HasOccurredAt {
  readonly occurredAt: string;
}

const DEFAULT_TIME_ZONE = 'UTC';

// `en-CA` formats as `YYYY-MM-DD` directly (ISO calendar order), which is what makes this both a
// stable grouping key and directly diffable via plain string equality -- no separate date-parsing
// step needed to compare two day keys.
const DAY_KEY_LOCALE = 'en-CA';

function dayKeyFor(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat(DAY_KEY_LOCALE, { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** Pure calendar arithmetic on an already-computed day key -- never re-derives a zoned instant,
 *  so a west-of-UTC or DST-changing `timeZone` can never introduce an off-by-one here. */
function shiftDayKey(dayKey: string, deltaDays: number): string {
  const parts = dayKey.split('-').map(Number);
  const [year, month, day] = parts;
  const shifted = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) + deltaDays));
  return new Intl.DateTimeFormat(DAY_KEY_LOCALE, { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(shifted);
}

const ABBREVIATED_DATE_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

function abbreviatedDateFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = ABBREVIATED_DATE_FORMATTER_CACHE.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en', { timeZone, month: 'short', day: 'numeric' });
    ABBREVIATED_DATE_FORMATTER_CACHE.set(timeZone, formatter);
  }
  return formatter;
}

function labelForDayKey(dayKey: string, todayKey: string, yesterdayKey: string, timeZone: string, sampleDate: Date): string {
  if (dayKey === todayKey) return 'TODAY';
  if (dayKey === yesterdayKey) return 'YESTERDAY';
  return abbreviatedDateFormatter(timeZone).format(sampleDate).toUpperCase();
}

interface Bucket<T> {
  readonly key: string;
  readonly items: T[];
  readonly sampleDate: Date;
}

/**
 * Groups `items` into ordered day buckets, newest bucket first, items inside a bucket also newest
 * first -- regardless of the order `items` arrives in (a defensive full sort, not a trust in the
 * caller's own ordering). `now`/`timeZone` are always explicit; this function never reads the
 * platform clock or the host's own default time zone.
 */
export function groupByDay<T extends HasOccurredAt>(
  items: readonly T[],
  now: Date,
  timeZone: string = DEFAULT_TIME_ZONE,
): readonly DayGroup<T>[] {
  if (items.length === 0) return [];

  const sorted = [...items].sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime());

  const todayKey = dayKeyFor(now, timeZone);
  const yesterdayKey = shiftDayKey(todayKey, -1);

  const buckets: Bucket<T>[] = [];
  const bucketByKey = new Map<string, Bucket<T>>();

  for (const entry of sorted) {
    const date = new Date(entry.occurredAt);
    const key = dayKeyFor(date, timeZone);
    let bucket = bucketByKey.get(key);
    if (bucket === undefined) {
      bucket = { key, items: [], sampleDate: date };
      bucketByKey.set(key, bucket);
      buckets.push(bucket);
    }
    bucket.items.push(entry);
  }

  return buckets.map((bucket) => ({
    label: labelForDayKey(bucket.key, todayKey, yesterdayKey, timeZone, bucket.sampleDate),
    items: bucket.items,
  }));
}

export type PageMergeMode = 'append' | 'refresh';

interface HasId {
  readonly id: string;
}

/**
 * Merges an `incoming` page into `existing`, de-duplicating by `id`. `'append'` (Load older) adds
 * genuinely-new items after `existing`; `'refresh'` (a page-1 resync) prepends genuinely-new items
 * before `existing` without discarding whatever older pages were already loaded. Either mode
 * returns `existing` itself, unchanged, when `incoming` adds nothing -- so a caller can skip a
 * re-render on a no-op refresh.
 */
export function mergePage<T extends HasId>(existing: readonly T[], incoming: readonly T[], mode: PageMergeMode): readonly T[] {
  const existingIds = new Set(existing.map((entry) => entry.id));
  const newItems = incoming.filter((entry) => !existingIds.has(entry.id));

  if (newItems.length === 0) return existing;

  return mode === 'append' ? [...existing, ...newItems] : [...newItems, ...existing];
}
