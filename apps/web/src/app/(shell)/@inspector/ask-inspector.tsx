'use client';

// 30-04: `?ask=1` on any page opens the read-only AI chat in the inspector. Closing removes only
// the `ask` parameter, so the rest of the page's query (filters, selections) survives.
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, type ReactNode } from 'react';
import { AiChat } from '../../../components/ai/AiChat';
import { InspectorFrame } from './inspector-frame';

export const ASK_PARAM = 'ask';

export function isAskOpen(search: Pick<URLSearchParams, 'get'>): boolean {
  return search.get(ASK_PARAM) === '1';
}

/** The current URL without the `ask` parameter. */
export function withoutAsk(pathname: string, search: URLSearchParams): string {
  const next = new URLSearchParams(search);
  next.delete(ASK_PARAM);
  const query = next.toString();
  return query === '' ? pathname : `${pathname}?${query}`;
}

function AskPanel(): ReactNode {
  const search = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  if (!isAskOpen(search)) return null;
  return (
    <InspectorFrame
      title="Ask Noodara"
      onClose={() => {
        router.replace(withoutAsk(pathname, new URLSearchParams(search.toString())), { scroll: false });
      }}
    >
      <AiChat />
    </InspectorFrame>
  );
}

export function AskInspector(): ReactNode {
  return (
    <Suspense fallback={null}>
      <AskPanel />
    </Suspense>
  );
}
