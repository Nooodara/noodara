// 10-06-PLAN.md Task 3: the "Included / Not included" table for the docs "Scope of this
// release" page (D-08/D-10). Renders directly from apps/site/src/content/scope.ts -- the
// docs page never hand-types a claim or a limit. Tokens only: hairline borders, flat surface,
// no raw color literal (checked by an acceptance-criteria grep).

import { DELIVERED_CAPABILITIES, SCOPE_EXCLUSIONS } from '../../content/scope';

export function ScopeTable() {
  const rowCount = Math.max(DELIVERED_CAPABILITIES.length, SCOPE_EXCLUSIONS.length);
  const rows = Array.from({ length: rowCount }, (_, i) => ({
    included: DELIVERED_CAPABILITIES[i]?.claim ?? '',
    notIncluded: SCOPE_EXCLUSIONS[i]?.statement ?? '',
  }));

  return (
    <table className="w-full border-collapse text-[length:var(--text-body-size)]">
      <thead>
        <tr>
          <th scope="col" className="border-b border-[var(--hairline)] px-[var(--space-4)] py-[var(--space-2)] text-left font-[var(--text-headline-weight)]">
            Included
          </th>
          <th scope="col" className="border-b border-[var(--hairline)] px-[var(--space-4)] py-[var(--space-2)] text-left font-[var(--text-headline-weight)]">
            Not included
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={`${row.included}|${row.notIncluded}`}>
            <td className="border-b border-[var(--hairline)] px-[var(--space-4)] py-[var(--space-2)] align-top">{row.included}</td>
            <td className="border-b border-[var(--hairline)] px-[var(--space-4)] py-[var(--space-2)] align-top">{row.notIncluded}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
