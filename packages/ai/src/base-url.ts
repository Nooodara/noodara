import { AIProviderConfigError } from './errors.js';
import type { AIProviderId } from './types.js';

// H2: where a provider key may be sent. Implemented vendors are pinned to their own host; an
// override is a test seam (or a future openai-compatible endpoint) and is validated strictly.

export const PINNED_BASE_URLS: Readonly<Partial<Record<AIProviderId, string>>> = Object.freeze({
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
});

export interface BaseUrlOptions {
  /** Explicit test seam: allows http and a non-allowlisted host. Never set in production. */
  readonly allowInsecureTestSeam?: boolean;
}

function normalize(url: URL): string {
  return url.href.replace(/\/+$/, '');
}

/** Resolves the base URL for `id`. Throws AIProviderConfigError; the URL itself is never echoed. */
export function resolveBaseUrl(id: AIProviderId, override?: string, options: BaseUrlOptions = {}): string {
  const pinned = PINNED_BASE_URLS[id];
  if (override === undefined) {
    if (pinned === undefined) throw new AIProviderConfigError('invalid_base_url');
    return pinned;
  }

  let url: URL;
  try {
    url = new URL(override);
  } catch {
    throw new AIProviderConfigError('invalid_base_url');
  }
  const testSeam = options.allowInsecureTestSeam === true;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && testSeam)) {
    throw new AIProviderConfigError('invalid_base_url');
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new AIProviderConfigError('invalid_base_url');
  }
  const resolved = normalize(url);
  // A vendor with a pinned host only accepts that host, unless the test seam is explicit.
  if (pinned !== undefined && resolved !== pinned && !testSeam) {
    throw new AIProviderConfigError('base_url_not_allowed');
  }
  return resolved;
}
