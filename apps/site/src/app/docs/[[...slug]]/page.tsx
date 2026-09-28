// 10-05-PLAN.md Task 2 (DOCS-01). `dynamicParams = false` + `source.generateParams()` (RESEARCH.md
// Pitfall 3) make this a fully SSG route with no server: `output: 'export'` hard-fails at build
// if anything here reaches a dynamic path. This file reads no request-scoped Next.js API at all.
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/page';
import { getMDXComponents } from '../../../mdx-components';
import { source } from '../../../lib/source';

export const dynamicParams = false;

export function generateStaticParams() {
  return source.generateParams();
}

interface PageProps {
  params: Promise<{ slug?: string[] }>;
}

export default async function Page({ params }: PageProps) {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (page === undefined) notFound();

  const MDXContent = page.data.body;

  return (
    <DocsPage toc={page.data.toc}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <MDXContent components={getMDXComponents()} />
      </DocsBody>
    </DocsPage>
  );
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (page === undefined) notFound();

  return {
    title: page.data.title,
    description: page.data.description,
    alternates: { canonical: page.url },
  };
}
