import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import nextConfig from '../next.config';
import { config as proxyConfig } from './proxy';

// The webhook payload URL the UI shows is `<public origin>/webhooks/github/<id>`, served by
// apps/web. GitHub posts there without a session, so it must reach the control plane unchanged.
const API_ORIGIN = 'http://api.test:3100';

function matcherRegex(): RegExp {
  const [pattern] = proxyConfig.matcher;
  if (pattern === undefined) throw new Error('proxy matcher missing');
  return new RegExp(`^${pattern}$`);
}

describe('web routing for webhooks', () => {
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env.NOODARA_API_ORIGIN;
    process.env.NOODARA_API_ORIGIN = API_ORIGIN;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.NOODARA_API_ORIGIN;
    else process.env.NOODARA_API_ORIGIN = previous;
  });

  it('rewrites /webhooks/* to the control plane', async () => {
    const rewrites = await nextConfig.rewrites?.();
    expect(rewrites).toContainEqual({
      source: '/webhooks/:path*',
      destination: `${API_ORIGIN}/webhooks/:path*`,
    });
  });

  it('keeps /webhooks/* out of the login redirect', () => {
    expect(matcherRegex().test('/webhooks/github/abc123')).toBe(false);
  });

  it('still redirects ordinary pages', () => {
    expect(matcherRegex().test('/servers')).toBe(true);
  });
});
