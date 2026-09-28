'use client';

// 10-05-PLAN.md Task 2 (D-08 static search), amended D-12a. `flexsearchStaticClient`'s `from`
// option (confirmed against apps/site/node_modules/fumadocs-core/dist/client-ByEdoQoD.d.ts -- NOT
// an "index URL" named option, `from`, defaulting to `/api/search`) is prefixed with the build's
// basePath: the static index is fetched by a raw `fetch(url)` call that Next.js does not rewrite
// the way it rewrites `<Link>`/`<Image>` -- basePath is always empty on Cloudflare Pages (D-12a),
// so this prefixing is a no-op today, but stays in place as the one place that would need to
// change if a non-root basePath were ever reintroduced.
import { useDocsSearch } from 'fumadocs-core/search/client';
import { flexsearchStaticClient } from 'fumadocs-core/search/client/flexsearch-static';
import {
  SearchDialog,
  SearchDialogClose,
  SearchDialogContent,
  SearchDialogFooter,
  SearchDialogHeader,
  SearchDialogIcon,
  SearchDialogInput,
  SearchDialogList,
  SearchDialogOverlay,
  type SharedProps,
} from 'fumadocs-ui/components/dialog/search';
import { assetPath } from '../lib/build-info';

export function SiteSearchDialog(props: SharedProps) {
  const { search, setSearch, query } = useDocsSearch({
    client: flexsearchStaticClient({ from: assetPath('/api/search') }),
  });

  return (
    <SearchDialog
      search={search}
      onSearchChange={setSearch}
      isLoading={query.isLoading}
      {...props}
    >
      <SearchDialogOverlay />
      <SearchDialogContent>
        <SearchDialogHeader>
          <SearchDialogIcon />
          <SearchDialogInput />
          <SearchDialogClose />
        </SearchDialogHeader>
        <SearchDialogList items={query.data !== 'empty' ? query.data : null} />
        <SearchDialogFooter />
      </SearchDialogContent>
    </SearchDialog>
  );
}
