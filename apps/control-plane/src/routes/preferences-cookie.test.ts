import { describe, expect, it } from 'vitest';
import { buildPreferencesSetCookie } from './preferences-cookie.js';

// D-09: the server-side mirror-cookie builder must produce a byte-for-byte equivalent cookie to
// the browser writer (packages/ui/src/ThemeToggle.tsx's applyPreferences), built from the same
// domain codec and constants -- never HttpOnly (a page script must read it back), never Domain=.

describe('buildPreferencesSetCookie (D-09)', () => {
  it('builds the Secure cookie string with the exact attribute order the browser writer uses', () => {
    const cookie = buildPreferencesSetCookie(
      { theme: 'dark', reduceMotion: 'on', density: 'compact' },
      { secure: true },
    );

    expect(cookie).toBe('noodara-prefs=dark.on.compact; Path=/; Max-Age=31536000; SameSite=Lax; Secure');
  });

  it('omits the Secure suffix when secure is false', () => {
    const cookie = buildPreferencesSetCookie(
      { theme: 'auto', reduceMotion: 'system', density: 'comfortable' },
      { secure: false },
    );

    expect(cookie).toBe('noodara-prefs=auto.system.comfortable; Path=/; Max-Age=31536000; SameSite=Lax');
  });

  it('never contains HttpOnly', () => {
    const cookie = buildPreferencesSetCookie(
      { theme: 'light', reduceMotion: 'off', density: 'compact' },
      { secure: true },
    );

    expect(cookie).not.toContain('HttpOnly');
  });

  it('never contains Domain=', () => {
    const cookie = buildPreferencesSetCookie(
      { theme: 'light', reduceMotion: 'off', density: 'compact' },
      { secure: true },
    );

    expect(cookie).not.toContain('Domain=');
  });
});
