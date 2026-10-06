// 13-02 H1: `updated_at` only moves forward per row, so events order writes to one entity.
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { services } from '../db/schema/services.js';
import { nextUpdatedAt, nextUpdatedAtSql } from './updated-at.js';

const T0 = new Date('2026-10-05T10:00:00.000Z');

describe('nextUpdatedAt', () => {
  it('takes now when it is later than the stored value', () => {
    const now = new Date(T0.getTime() + 5_000);
    expect(nextUpdatedAt(T0, now)).toEqual(now);
  });

  it('moves 1 ms past the stored value when two writes land in the same millisecond', () => {
    expect(nextUpdatedAt(T0, new Date(T0))).toEqual(new Date(T0.getTime() + 1));
  });

  it('never goes back when the clock steps back', () => {
    expect(nextUpdatedAt(T0, new Date(T0.getTime() - 60_000))).toEqual(new Date(T0.getTime() + 1));
  });

  it('a burst of writes with a frozen clock yields strictly increasing values', () => {
    let current = T0;
    const seen: number[] = [];
    for (let i = 0; i < 50; i += 1) {
      current = nextUpdatedAt(current, T0);
      seen.push(current.getTime());
    }
    expect(seen.every((value, index) => index === 0 || value > (seen[index - 1] ?? Infinity))).toBe(true);
    expect(seen[0]).toBeGreaterThan(T0.getTime());
  });
});

describe('nextUpdatedAtSql', () => {
  it('renders greatest(now, column + 1 ms) with now as a bound parameter', () => {
    const query = new PgDialect().sqlToQuery(nextUpdatedAtSql(services.updatedAt, T0));
    expect(query.sql).toBe(`greatest($1::timestamptz, "services"."updated_at" + interval '1 millisecond')`);
    expect(query.params).toEqual([T0.toISOString()]);
  });
});
