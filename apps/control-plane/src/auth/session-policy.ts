import type { BetterAuthOptions } from 'better-auth';

// Owned by Plan 01-11 (D-05: 7-day sliding window with a hard 30-day ceiling from login,
// `updateAge` capped at one renewal per day). `hooks` is intentionally empty here — Plan 01-11
// fills in the `databaseHooks.session` clamp that keeps a renewed `expiresAt` from ever crossing
// `absoluteExpiresAt`.
//
// `additionalFields.absoluteExpiresAt` below exists only so `sessions.absolute_expires_at`
// (NOT NULL, Plan 01-07) is populated at all — Better Auth doesn't know about this column unless
// told, and a default is required for every session Better Auth creates (sign-in, sign-up) to
// succeed at the database level. Plan 01-11 replaces `defaultValue` with the real clamped value
// computed from the configured ceiling; until then, every session gets this same 30-day default.
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

type SessionConfig = NonNullable<BetterAuthOptions['session']>;
type DatabaseHooksConfig = NonNullable<BetterAuthOptions['databaseHooks']>;

export const sessionPolicy: { config: SessionConfig; hooks: DatabaseHooksConfig } = {
  config: {
    additionalFields: {
      absoluteExpiresAt: {
        type: 'date',
        required: false,
        input: false,
        returned: false,
        defaultValue: () => new Date(Date.now() + THIRTY_DAYS_MS),
      },
    },
  },
  hooks: {},
};
