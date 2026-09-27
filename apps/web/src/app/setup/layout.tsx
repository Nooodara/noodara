import type { ReactNode } from 'react';

// The one-time setup token travels in `/setup?token=...`. Any *dynamic* render of that URL embeds
// the request's search params in the HTML document (the RSC flight payload carries the segment key
// `__PAGE__?{"token":...}` and `serverProvidedParams.searchParams`), which is exactly the response
// body tests/e2e/canary-ui.spec.ts step 11 forbids. The root layout's `cookies()` read (09-07,
// D-09) opted every route into dynamic rendering, so this segment pins /setup back to static:
// `force-static` makes `cookies()` return empty for this route, the document is prerendered once
// at build time with no request data in it, and the page reads the token on the client only.
// Cost: /setup paints the OS theme until the bootstrap script runs -- acceptable for a page that
// exists before any account (and any saved preference) does.
export const dynamic = 'force-static';

export default function SetupLayout({ children }: { children: ReactNode }) {
  return children;
}
