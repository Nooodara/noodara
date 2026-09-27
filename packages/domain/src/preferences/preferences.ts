// Preferences domain contract (SET-04/SET-05, 09-CONTEXT.md D-09/D-11/D-13/D-14/D-16). The single
// definition of a user's visual preferences: theme, reduce-motion and density, plus the codec for
// the `noodara-prefs` mirror cookie every other layer (SSR root layout, /login, /setup, the
// PATCH /api/account/preferences endpoint) reads and writes through. zod is the only dependency;
// this module has no I/O (packages/domain purity boundary, purity.test.ts).
import { z } from 'zod';

export const THEME_PREFERENCES = ['auto', 'light', 'dark'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export const REDUCE_MOTION_PREFERENCES = ['system', 'on', 'off'] as const;
export type ReduceMotionPreference = (typeof REDUCE_MOTION_PREFERENCES)[number];

export const DENSITY_PREFERENCES = ['comfortable', 'compact'] as const;
export type DensityPreference = (typeof DENSITY_PREFERENCES)[number];

/** Strict schema: every key required, unknown keys rejected, enums closed. */
export const PreferencesSchema = z
  .object({
    theme: z.enum(THEME_PREFERENCES),
    reduceMotion: z.enum(REDUCE_MOTION_PREFERENCES),
    density: z.enum(DENSITY_PREFERENCES),
  })
  .strict();

export type Preferences = z.infer<typeof PreferencesSchema>;

/** Strict, all-optional patch schema (`PATCH /api/account/preferences` body) -- refined so an
 *  empty patch (nothing to change) is rejected rather than silently accepted as a no-op. */
export const PreferencesPatchSchema = z
  .object({
    theme: z.enum(THEME_PREFERENCES).optional(),
    reduceMotion: z.enum(REDUCE_MOTION_PREFERENCES).optional(),
    density: z.enum(DENSITY_PREFERENCES).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one preference is required',
  });

export type PreferencesPatch = z.infer<typeof PreferencesPatchSchema>;

export const DEFAULT_PREFERENCES: Readonly<Preferences> = Object.freeze({
  theme: 'auto',
  reduceMotion: 'system',
  density: 'comfortable',
});

/**
 * The lenient reader for the `users.preferences` jsonb column (D-16). Never throws: an unknown
 * shape, a missing field or an invalid enum value falls back to the default for that field alone,
 * so one corrupted field never discards the rest of a user's saved preferences.
 */
export function resolveStoredPreferences(raw: unknown): Preferences {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return DEFAULT_PREFERENCES;
  }

  const record = raw as Record<string, unknown>;
  const theme = THEME_PREFERENCES.includes(record.theme as ThemePreference)
    ? (record.theme as ThemePreference)
    : DEFAULT_PREFERENCES.theme;
  const reduceMotion = REDUCE_MOTION_PREFERENCES.includes(record.reduceMotion as ReduceMotionPreference)
    ? (record.reduceMotion as ReduceMotionPreference)
    : DEFAULT_PREFERENCES.reduceMotion;
  const density = DENSITY_PREFERENCES.includes(record.density as DensityPreference)
    ? (record.density as DensityPreference)
    : DEFAULT_PREFERENCES.density;

  return { theme, reduceMotion, density };
}

/** Applies a validated patch on top of the current preferences, returning a new object. */
export function mergePreferences(current: Preferences, patch: PreferencesPatch): Preferences {
  return {
    theme: patch.theme ?? current.theme,
    reduceMotion: patch.reduceMotion ?? current.reduceMotion,
    density: patch.density ?? current.density,
  };
}

export const PREFERENCES_COOKIE_NAME = 'noodara-prefs';
export const PREFERENCES_COOKIE_MAX_AGE_SECONDS = 31_536_000;

const PREFERENCES_COOKIE_MAX_LENGTH = 64;

export function serializePreferencesCookieValue(preferences: Preferences): string {
  return `${preferences.theme}.${preferences.reduceMotion}.${preferences.density}`;
}

/**
 * Parses the `noodara-prefs` cookie value (T-09-06 mitigation): the result only ever contains
 * enum members or the per-field default, never raw input. `undefined`/`''` (cookie absent) return
 * `null` so callers can distinguish "no mirror cookie" from "mirror cookie present but garbage".
 * Anything over 64 chars or without exactly three dot-separated segments is treated as a fully
 * corrupted value and resolves to `DEFAULT_PREFERENCES` as a whole, never echoing the raw input.
 */
export function parsePreferencesCookieValue(value: string | undefined): Preferences | null {
  if (value === undefined || value === '') {
    return null;
  }
  if (value.length > PREFERENCES_COOKIE_MAX_LENGTH) {
    return DEFAULT_PREFERENCES;
  }

  const segments = value.split('.');
  if (segments.length !== 3) {
    return DEFAULT_PREFERENCES;
  }

  const [rawTheme, rawReduceMotion, rawDensity] = segments;
  const theme = THEME_PREFERENCES.includes(rawTheme as ThemePreference)
    ? (rawTheme as ThemePreference)
    : DEFAULT_PREFERENCES.theme;
  const reduceMotion = REDUCE_MOTION_PREFERENCES.includes(rawReduceMotion as ReduceMotionPreference)
    ? (rawReduceMotion as ReduceMotionPreference)
    : DEFAULT_PREFERENCES.reduceMotion;
  const density = DENSITY_PREFERENCES.includes(rawDensity as DensityPreference)
    ? (rawDensity as DensityPreference)
    : DEFAULT_PREFERENCES.density;

  return { theme, reduceMotion, density };
}

export interface RootPreferenceAttributes {
  readonly 'data-theme'?: 'light' | 'dark';
  readonly 'data-motion'?: 'reduce' | 'allow';
  readonly 'data-density'?: 'compact';
}

/**
 * Maps `Preferences` to the `<html>` attributes the SSR root layout sets before the first paint
 * (D-09, D-13, D-14). An absent key always means "system" or "default" -- `auto` theme, `system`
 * reduce-motion and `comfortable` density never appear as an explicit attribute value.
 */
export function preferencesToRootAttributes(preferences: Preferences): RootPreferenceAttributes {
  const attributes: {
    'data-theme'?: 'light' | 'dark';
    'data-motion'?: 'reduce' | 'allow';
    'data-density'?: 'compact';
  } = {};

  if (preferences.theme === 'light' || preferences.theme === 'dark') {
    attributes['data-theme'] = preferences.theme;
  }
  if (preferences.reduceMotion === 'on') {
    attributes['data-motion'] = 'reduce';
  } else if (preferences.reduceMotion === 'off') {
    attributes['data-motion'] = 'allow';
  }
  if (preferences.density === 'compact') {
    attributes['data-density'] = 'compact';
  }

  return attributes;
}
