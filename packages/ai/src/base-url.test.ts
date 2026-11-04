import { describe, expect, it } from 'vitest';
import { PINNED_BASE_URLS, resolveBaseUrl } from './base-url.js';
import { AIProviderConfigError } from './errors.js';
import { createGuardedFetch } from './guarded-fetch.js';

// H2: base URLs come from a per-provider allowlist; overrides are validated strictly.

function reasonOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AIProviderConfigError);
    return (error as AIProviderConfigError).reason;
  }
  return undefined;
}

describe('resolveBaseUrl', () => {
  it('uses the pinned vendor host by default', () => {
    expect(resolveBaseUrl('anthropic')).toBe('https://api.anthropic.com');
    expect(resolveBaseUrl('openai')).toBe('https://api.openai.com/v1');
    expect(PINNED_BASE_URLS).toEqual({ anthropic: 'https://api.anthropic.com', openai: 'https://api.openai.com/v1' });
  });

  it('accepts the pinned host spelled as an override', () => {
    expect(resolveBaseUrl('openai', 'https://api.openai.com/v1/')).toBe('https://api.openai.com/v1');
  });

  it('rejects a non-allowlisted host for a pinned vendor unless the test seam is explicit', () => {
    expect(reasonOf(() => resolveBaseUrl('anthropic', 'https://evil.example.com'))).toBe('base_url_not_allowed');
    expect(resolveBaseUrl('anthropic', 'https://mock.local:8443', { allowInsecureTestSeam: true })).toBe('https://mock.local:8443');
  });

  it('accepts an https override for an openai-compatible endpoint', () => {
    expect(resolveBaseUrl('openai-compatible', 'https://llm.internal.example/v1')).toBe('https://llm.internal.example/v1');
    expect(reasonOf(() => resolveBaseUrl('openai-compatible'))).toBe('invalid_base_url');
  });

  it.each([
    'http://api.openai.com/v1',
    'file:///etc/passwd',
    'data:text/plain,hello',
    'javascript:alert(1)',
    'ftp://api.openai.com',
    'https://user:pass@api.openai.com/v1',
    'https://key@api.openai.com/v1',
    'https://api.openai.com/v1?key=abc',
    'https://api.openai.com/v1#frag',
    'not a url',
  ])('rejects %s', (override) => {
    expect(reasonOf(() => resolveBaseUrl('openai-compatible', override))).toBe('invalid_base_url');
  });

  it('allows http only behind the explicit test seam, never file, data or javascript', () => {
    expect(resolveBaseUrl('openai-compatible', 'http://127.0.0.1:9999', { allowInsecureTestSeam: true })).toBe('http://127.0.0.1:9999');
    for (const override of ['file:///tmp/x', 'data:text/plain,x', 'javascript:alert(1)', 'http://u:p@127.0.0.1']) {
      expect(reasonOf(() => resolveBaseUrl('openai-compatible', override, { allowInsecureTestSeam: true }))).toBe('invalid_base_url');
    }
  });

  it('never echoes the rejected URL', () => {
    try {
      resolveBaseUrl('openai-compatible', 'https://sk-secret@host.example');
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain('sk-secret');
      expect(String(error)).not.toContain('sk-secret');
    }
  });
});

describe('guarded fetch host pinning', () => {
  it('refuses a request outside the pinned base without sending it', async () => {
    let sent = 0;
    const state = { failure: undefined };
    const guarded = createGuardedFetch({
      baseUrl: 'https://api.openai.com/v1',
      maxResponseBytes: 1_024,
      idleTimeoutMs: 1_000,
      signal: new AbortController().signal,
      state,
      fetchImpl: () => {
        sent += 1;
        return Promise.resolve(new Response('{}'));
      },
    });
    for (const url of ['https://evil.example/v1/chat', 'https://api.openai.com/v2/chat', 'https://api.openai.com/v1x', 'https://u@api.openai.com/v1/chat']) {
      await expect(guarded(url)).rejects.toMatchObject({ reason: 'host_mismatch' });
    }
    expect(sent).toBe(0);
    await guarded('https://api.openai.com/v1/chat/completions');
    expect(sent).toBe(1);
  });
});
