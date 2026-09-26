import { Children, type ReactNode } from 'react';

export interface InsetGroupProps {
  readonly title?: string;
  readonly children: ReactNode;
  readonly 'data-testid'?: string;
}

const TITLE_CLASSES = 'text-label uppercase text-ink-secondary';
const BLOCK_CLASSES = 'overflow-hidden rounded-lg border border-hairline bg-surface-1';
const ROW_CLASSES = 'border-b border-hairline last:border-b-0';

// InsetGroup (D-01/D-02, 08-UI-SPEC.md §1) -- the macOS System Settings / iOS grouped-list
// surface: an optional title outside the block, and inside the block each row separated from the
// next by a hairline, the last carrying none. This is an elevation step (surface-1 on canvas,
// hairline border, radius lg) rather than a floating surface -- it must never carry a shadow
// (§9 #2; scripts/check-ui-safety.mjs's shadow-outside-allowlist gate enforces this repo-wide)
// and must never nest inside another InsetGroup (§9 #5). There is no runtime guard against
// nesting: a hard throw would only ever be reachable through a programming error, never user
// input, so the invariant is documented here and by this file's own test (InsetGroup.test.tsx)
// as a structural, review-enforced expectation rather than a thrown error.
export function InsetGroup({ title, children, 'data-testid': testId }: InsetGroupProps): ReactNode {
  const rows = Children.toArray(children);

  return (
    <div className="flex flex-col gap-2">
      {title !== undefined ? <h3 className={TITLE_CLASSES}>{title}</h3> : null}
      <div data-testid={testId} data-inset-group="true" className={BLOCK_CLASSES}>
        {rows.map((row, index) => (
          // `index` as key: rows is a static, non-reordered list for the lifetime of a given
          // InsetGroup composition -- same precedent as ServerList.tsx's own fixed-length
          // skeleton row list.
          <div key={index} className={ROW_CLASSES}>
            {row}
          </div>
        ))}
      </div>
    </div>
  );
}
