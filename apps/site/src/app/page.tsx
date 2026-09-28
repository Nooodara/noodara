import type { Metadata } from 'next';
import { Landing } from '../components/landing/Landing';

// 10-11-PLAN.md Task 2 (D-01..D-06). Replaces 10-02's placeholder route: `/` now renders the real
// landing composed from tested parts (Landing.tsx). `alternates.canonical` matches the root
// layout's own metadataBase discipline -- the canonical URL is always this route, at the root
// (D-12a: basePath is always empty on Cloudflare Pages).
export const metadata: Metadata = {
  alternates: {
    canonical: '/',
  },
};

export default function HomePage() {
  return <Landing />;
}
