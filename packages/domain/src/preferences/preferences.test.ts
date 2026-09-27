// Task 1 RED (09-01-PLAN.md): packages/domain/src/preferences/preferences.ts does not exist yet
// -- every import below fails to resolve, which is the right reason for this file to fail before
// implementation exists.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFERENCES,
  mergePreferences,
  parsePreferencesCookieValue,
  PREFERENCES_COOKIE_NAME,
  PreferencesPatchSchema,
  PreferencesSchema,
  preferencesToRootAttributes,
  resolveStoredPreferences,
  serializePreferencesCookieValue,
  type Preferences,
} from './preferences.js';

describe('DEFAULT_PREFERENCES', () => {
  it('equals the documented defaults and is frozen', () => {
    expect(DEFAULT_PREFERENCES).toEqual({ theme: 'auto', reduceMotion: 'system', density: 'comfortable' });
    expect(Object.isFrozen(DEFAULT_PREFERENCES)).toBe(true);
  });
});

describe('PREFERENCES_COOKIE_NAME', () => {
  it('is noodara-prefs', () => {
    expect(PREFERENCES_COOKIE_NAME).toBe('noodara-prefs');
  });
});

describe('PreferencesSchema', () => {
  const valid: Preferences = { theme: 'dark', reduceMotion: 'on', density: 'compact' };

  it('accepts a valid preferences object', () => {
    expect(PreferencesSchema.parse(valid)).toEqual(valid);
  });

  it('rejects an unknown key (strict)', () => {
    expect(() => PreferencesSchema.parse({ ...valid, userId: 'x' })).toThrow();
  });

  it('rejects a value outside the theme enum', () => {
    expect(() => PreferencesSchema.parse({ ...valid, theme: 'purple' })).toThrow();
  });

  it('rejects a value outside the reduceMotion enum', () => {
    expect(() => PreferencesSchema.parse({ ...valid, reduceMotion: 'maybe' })).toThrow();
  });

  it('rejects a value outside the density enum', () => {
    expect(() => PreferencesSchema.parse({ ...valid, density: 'huge' })).toThrow();
  });
});

describe('PreferencesPatchSchema', () => {
  it('accepts a single key patch', () => {
    expect(PreferencesPatchSchema.parse({ theme: 'dark' })).toEqual({ theme: 'dark' });
  });

  it('rejects an empty patch', () => {
    expect(() => PreferencesPatchSchema.parse({})).toThrow();
  });

  it('rejects an unknown key (strict)', () => {
    expect(() => PreferencesPatchSchema.parse({ userId: 'x' })).toThrow();
  });

  it('rejects an invalid enum value', () => {
    expect(() => PreferencesPatchSchema.parse({ theme: 'purple' })).toThrow();
  });
});

describe('resolveStoredPreferences', () => {
  it('returns DEFAULT_PREFERENCES for an empty object', () => {
    expect(resolveStoredPreferences({})).toEqual(DEFAULT_PREFERENCES);
  });

  it('keeps valid fields and defaults invalid ones per-field', () => {
    expect(resolveStoredPreferences({ theme: 'dark', density: 'bogus' })).toEqual({
      theme: 'dark',
      reduceMotion: 'system',
      density: 'comfortable',
    });
  });

  it('returns DEFAULT_PREFERENCES for null', () => {
    expect(resolveStoredPreferences(null)).toEqual(DEFAULT_PREFERENCES);
  });

  it('returns DEFAULT_PREFERENCES for a string', () => {
    expect(resolveStoredPreferences('x')).toEqual(DEFAULT_PREFERENCES);
  });

  it('returns DEFAULT_PREFERENCES for an array', () => {
    expect(resolveStoredPreferences([])).toEqual(DEFAULT_PREFERENCES);
  });

  it('defaults an invalid reduceMotion field while keeping valid fields', () => {
    expect(resolveStoredPreferences({ theme: 'dark', reduceMotion: 'bogus', density: 'compact' })).toEqual({
      theme: 'dark',
      reduceMotion: 'system',
      density: 'compact',
    });
  });
});

describe('mergePreferences', () => {
  it('returns a new object with only the patched field changed', () => {
    const result = mergePreferences(DEFAULT_PREFERENCES, { density: 'compact' });
    expect(result).toEqual({ theme: 'auto', reduceMotion: 'system', density: 'compact' });
    expect(result).not.toBe(DEFAULT_PREFERENCES);
  });
});

describe('serializePreferencesCookieValue', () => {
  it('joins theme.reduceMotion.density with a dot', () => {
    expect(serializePreferencesCookieValue({ theme: 'dark', reduceMotion: 'on', density: 'compact' })).toBe(
      'dark.on.compact',
    );
  });
});

describe('parsePreferencesCookieValue', () => {
  it('returns null for undefined', () => {
    expect(parsePreferencesCookieValue(undefined)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(parsePreferencesCookieValue('')).toBeNull();
  });

  it('round-trips a valid value', () => {
    expect(parsePreferencesCookieValue('dark.on.compact')).toEqual({
      theme: 'dark',
      reduceMotion: 'on',
      density: 'compact',
    });
  });

  it('defaults per-segment on a tampered segment', () => {
    expect(parsePreferencesCookieValue('dark.<script>.compact')).toEqual({
      theme: 'dark',
      reduceMotion: 'system',
      density: 'compact',
    });
  });

  it('returns DEFAULT_PREFERENCES for garbage with the wrong segment count', () => {
    expect(parsePreferencesCookieValue('garbage')).toEqual(DEFAULT_PREFERENCES);
  });

  it('returns DEFAULT_PREFERENCES for a value longer than 64 chars', () => {
    expect(parsePreferencesCookieValue('a'.repeat(65))).toEqual(DEFAULT_PREFERENCES);
  });

  it('defaults an invalid theme segment while keeping the other valid segments', () => {
    expect(parsePreferencesCookieValue('bogus.on.compact')).toEqual({
      theme: 'auto',
      reduceMotion: 'on',
      density: 'compact',
    });
  });

  it('defaults an invalid density segment while keeping the other valid segments', () => {
    expect(parsePreferencesCookieValue('dark.on.bogus')).toEqual({
      theme: 'dark',
      reduceMotion: 'on',
      density: 'comfortable',
    });
  });
});

describe('preferencesToRootAttributes', () => {
  it('omits data-theme for auto', () => {
    expect(preferencesToRootAttributes({ theme: 'auto', reduceMotion: 'system', density: 'comfortable' })).toEqual({});
  });

  it('sets data-theme light', () => {
    expect(
      preferencesToRootAttributes({ theme: 'light', reduceMotion: 'system', density: 'comfortable' }),
    ).toEqual({ 'data-theme': 'light' });
  });

  it('sets data-theme dark', () => {
    expect(preferencesToRootAttributes({ theme: 'dark', reduceMotion: 'system', density: 'comfortable' })).toEqual({
      'data-theme': 'dark',
    });
  });

  it('sets data-motion reduce for on', () => {
    expect(preferencesToRootAttributes({ theme: 'auto', reduceMotion: 'on', density: 'comfortable' })).toEqual({
      'data-motion': 'reduce',
    });
  });

  it('sets data-motion allow for off', () => {
    expect(preferencesToRootAttributes({ theme: 'auto', reduceMotion: 'off', density: 'comfortable' })).toEqual({
      'data-motion': 'allow',
    });
  });

  it('omits data-motion for system', () => {
    expect(preferencesToRootAttributes({ theme: 'auto', reduceMotion: 'system', density: 'comfortable' })).toEqual(
      {},
    );
  });

  it('sets data-density compact', () => {
    expect(preferencesToRootAttributes({ theme: 'auto', reduceMotion: 'system', density: 'compact' })).toEqual({
      'data-density': 'compact',
    });
  });

  it('omits data-density for comfortable', () => {
    expect(preferencesToRootAttributes({ theme: 'auto', reduceMotion: 'system', density: 'comfortable' })).toEqual(
      {},
    );
  });

  it('combines multiple non-default attributes', () => {
    expect(preferencesToRootAttributes({ theme: 'dark', reduceMotion: 'on', density: 'compact' })).toEqual({
      'data-theme': 'dark',
      'data-motion': 'reduce',
      'data-density': 'compact',
    });
  });
});
