'use client';

// 10-05-PLAN.md Task 2 (D-08 static search). `flexsearchStaticClient`'s `from` option (confirmed
// against apps/site/node_modules/fumadocs-core/dist/client-ByEdoQoD.d.ts -- NOT an "index URL"
// named option, `from`, defaulting to `/api/search`) is prefixed with the build's basePath: the
// static index is fetched by a raw `fetch(url)` call that Next.js does not rewrite the way it
// rewrites `<Link>`/`<Image>` -- without the prefix, a CNAME-absent `/noodara` build would 404
// fetching `/api/search` instead of `/noodara/api/search`.
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
