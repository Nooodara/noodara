import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PREFERENCES, type Preferences } from '@noodara/domain/preferences';
import type { ApiResult } from './api-client';
import { updateAppearancePreference, type UpdateAppearanceDeps } from './appearance';

function buildDeps() {
  return {
    apply: vi.fn<UpdateAppearanceDeps['apply']>(),
    setStored: vi.fn<UpdateAppearanceDeps['setStored']>(),
    send: vi.fn<(method: 'PATCH', path: string, body?: unknown) => Promise<ApiResult<Preferences>>>(),
    getCurrent: vi.fn<UpdateAppearanceDeps['getCurrent']>(() => ({
      theme: 'auto',
      reduceMotion: 'system',
      density: 'comfortable',
    })),
  };
}

// vitest's `Mock<T>` erases a generic call signature's own type parameter to `unknown` (a known
// limitation of the mock type, not a workaround specific to this file) -- every real call site
// only ever instantiates `send`'s `T` as `Preferences`, so this narrow, single-purpose cast back
// to `UpdateAppearanceDeps['send']` is exact for every test in this file.
function asDeps(deps: object): Partial<UpdateAppearanceDeps> {
  return deps;
}

describe('updateAppearancePreference', () => {
  it('applies optimistically before sending the request, then persists on success', async () => {
    const deps = buildDeps();
    const serverResponse: Preferences = { theme: 'dark', reduceMotion: 'system', density: 'comfortable' };
    deps.send.mockResolvedValue({ ok: true, data: serverResponse } satisfies ApiResult<Preferences>);

    const callOrder: string[] = [];
    deps.apply.mockImplementation(() => callOrder.push('apply'));
    deps.send.mockImplementation(() => {
      callOrder.push('send');
      return Promise.resolve({ ok: true, data: serverResponse } satisfies ApiResult<Preferences>);
    });

    const result = await updateAppearancePreference('theme', 'dark', asDeps(deps));

    expect(callOrder).toEqual(['apply', 'send']);
    expect(deps.apply).toHaveBeenCalledWith({ theme: 'dark', reduceMotion: 'system', density: 'comfortable' });
    expect(deps.setStored).toHaveBeenNthCalledWith(1, { theme: 'dark', reduceMotion: 'system', density: 'comfortable' });
    expect(deps.send).toHaveBeenCalledWith('PATCH', '/api/account/preferences', { theme: 'dark' });
    expect(deps.setStored).toHaveBeenNthCalledWith(2, serverResponse);
    expect(result).toEqual({ ok: true });
  });

  it('reverts apply and setStored to the previous value and returns a message on failure', async () => {
    const deps = buildDeps();
    deps.send.mockResolvedValue({
      ok: false,
      code: 'INTERNAL_ERROR',
      message: 'boom',
      unauthorized: false,
    } satisfies ApiResult<Preferences>);

    const result = await updateAppearancePreference('reduceMotion', 'on', asDeps(deps));

    expect(deps.apply).toHaveBeenNthCalledWith(1, { theme: 'auto', reduceMotion: 'on', density: 'comfortable' });
    expect(deps.apply).toHaveBeenNthCalledWith(2, { theme: 'auto', reduceMotion: 'system', density: 'comfortable' });
    expect(deps.setStored).toHaveBeenNthCalledWith(1, { theme: 'auto', reduceMotion: 'on', density: 'comfortable' });
    expect(deps.setStored).toHaveBeenNthCalledWith(2, { theme: 'auto', reduceMotion: 'system', density: 'comfortable' });
    expect(result).toEqual({ ok: false, message: "Couldn't save your appearance settings. Try again." });
  });

  it('sends only the changed key in the PATCH body', async () => {
    const deps = buildDeps();
    deps.send.mockResolvedValue({
      ok: true,
      data: { theme: 'auto', reduceMotion: 'system', density: 'compact' },
    } satisfies ApiResult<Preferences>);

    await updateAppearancePreference('density', 'compact', asDeps(deps));

    expect(deps.send).toHaveBeenCalledWith('PATCH', '/api/account/preferences', { density: 'compact' });
  });

  it('falls back to DEFAULT_PREFERENCES with no injected deps and no mirror cookie present', async () => {
    // This file runs under Vitest's node-environment `apps` project (no `document`) -- exactly
    // the "no mirror yet" case this test exercises: `readPreferencesMirror`'s own try/catch
    // already degrades a throwing/absent `document` to `null`, so `defaultGetCurrent` falls
    // through to `DEFAULT_PREFERENCES` without this test needing to fake a cookie at all.
    const sendSpy = vi.fn().mockResolvedValue({
      ok: true,
      data: { ...DEFAULT_PREFERENCES, theme: 'light' },
    } satisfies ApiResult<Preferences>);

    const result = await updateAppearancePreference(
      'theme',
      'light',
      asDeps({ apply: vi.fn(), setStored: vi.fn(), send: sendSpy, getCurrent: vi.fn() }),
    );

    expect(sendSpy).toHaveBeenCalledWith('PATCH', '/api/account/preferences', { theme: 'light' });
    expect(result).toEqual({ ok: true });
  });
});
