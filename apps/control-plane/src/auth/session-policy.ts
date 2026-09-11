import type { BetterAuthOptions } from 'better-auth';
import { env } from '../env.js';

// RESOLUTION OF RESEARCH OPEN QUESTION 1 (01-RESEARCH.md, "Open Questions (RESOLVED)" #1) — D-05,
// as clarified 2026-09-10: a session slides on activity in 7-day steps, renewed at most once per
// day, with a hard, structural 30-day ceiling from creation that no amount of activity can push
// past.
//
// `expiresIn: 30d, updateAge: 7d` (RESEARCH Pattern 2's original sketch) was rejected: that
// combination makes 30 days the *sliding window* itself (refreshed at most every 7 days), the
// exact opposite of what D-05 actually asks for.
//
// The mechanism used here instead: `expiresIn` IS the 7-day sliding window and `updateAge` IS the
// one-day minimum renewal interval — Better Auth's own semantics for those two options already
// match D-05's "renews with a cadence of at most one renewal per day" literally, with no custom
// scheduling logic needed. The 30-day ceiling is a separate `absolute_expires_at` column (Plan
// 01-07), set once by the `session.create.before` hook below from `createdAt +
// NOODARA_SESSION_ABSOLUTE_SECONDS` and never moved again. Every `session.update.before` (the
// refresh Better Auth performs once `updateAge` has elapsed) clamps its own proposed new
// `expiresAt` down to that stored `absolute_expires_at` via `clampExpiry` before the write reaches
// the database — the ceiling is enforced by ordinary clamping on every write, not by a bespoke
// validation path checked separately at read time. A session refreshed every single day still
// expires the instant its clamped `expiresAt` falls in the past, which the ordinary
// `expiresAt < now` check every Better Auth session read already performs.

type SessionConfig = NonNullable<BetterAuthOptions['session']>;
type DatabaseHooksConfig = NonNullable<BetterAuthOptions['databaseHooks']>;
type SessionHooks = NonNullable<DatabaseHooksConfig['session']>;
type SessionCreateBefore = NonNullable<NonNullable<SessionHooks['create']>['before']>;
type SessionUpdateBefore = NonNullable<NonNullable<SessionHooks['update']>['before']>;

/** Returns whichever of the two dates is earlier — the clamp that enforces the 30-day ceiling. */
export function clampExpiry(proposedExpiresAt: Date, absoluteExpiresAt: Date): Date {
  return proposedExpiresAt.getTime() <= absoluteExpiresAt.getTime() ? proposedExpiresAt : absoluteExpiresAt;
}

function toDate(value: unknown): Date | undefined {
  return value instanceof Date ? value : undefined;
}

const sessionCreateBefore: SessionCreateBefore = (session) => {
  const createdAt = toDate(session.createdAt) ?? sessionPolicy.clock();
  const absoluteExpiresAt = new Date(createdAt.getTime() + env.NOODARA_SESSION_ABSOLUTE_SECONDS * 1000);
  return Promise.resolve({ data: { absoluteExpiresAt, lastSeenAt: createdAt } });
};

const sessionUpdateBefore: SessionUpdateBefore = (session, context) => {
  const now = sessionPolicy.clock();
  const data: Record<string, unknown> = { lastSeenAt: now };

  const proposedExpiresAt = toDate(session.expiresAt);
  // `session.update.before` only ever receives the fields being *written* (typically just
  // `expiresAt`/`updatedAt`), never the row's other columns — the currently-stored
  // `absolute_expires_at` has to come from the session Better Auth already fetched for this
  // request (`context.context.session`, set by the get-session flow before it decides to
  // refresh), not from `session` itself (confirmed against the installed
  // `better-auth`/`@better-auth/core` types, not assumed from docs prose).
  const existingAbsoluteExpiresAt = toDate(context?.context.session?.session.absoluteExpiresAt);
  if (proposedExpiresAt && existingAbsoluteExpiresAt) {
    data.expiresAt = clampExpiry(proposedExpiresAt, existingAbsoluteExpiresAt);
  }

  return Promise.resolve({ data });
};

export const sessionPolicy: {
  /** Injectable so unit tests never need `vi.setSystemTime`; integration tests instead
   *  manipulate the database's own timestamps directly (session-lifetime.test.ts). */
  clock: () => Date;
  config: SessionConfig;
  hooks: DatabaseHooksConfig;
} = {
  clock: () => new Date(),
  config: {
    expiresIn: env.NOODARA_SESSION_SLIDING_SECONDS,
    updateAge: env.NOODARA_SESSION_UPDATE_AGE_SECONDS,
    additionalFields: {
      // `returned` stays at its default (included) for `absoluteExpiresAt`: Better Auth's own
      // `findSession()` runs every fetched row through `parseSessionOutput` — which strips any
      // `returned: false` field — *before* setting `context.context.session`, the only place
      // `session.update.before` (below) can read the row's stored ceiling back from. Hiding this
      // field would make the clamp itself blind to it (confirmed by reading the installed
      // `better-auth` internal-adapter source, not assumed from docs prose). It is not sensitive
      // data — a session's absolute expiry timestamp carries no more risk than `expiresAt` itself,
      // which Better Auth already returns.
      absoluteExpiresAt: {
        type: 'date',
        required: false,
        input: false,
      },
      lastSeenAt: {
        type: 'date',
        required: false,
        input: false,
        returned: false,
      },
    },
  },
  hooks: {
    session: {
      create: { before: sessionCreateBefore },
      update: { before: sessionUpdateBefore },
    },
  },
};
