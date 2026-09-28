// 10-11-PLAN.md Task 2 (D-03, T-10-04). "What it does not do yet" -- every showOnLanding
// exclusion's statement read straight from scope.ts (never retyped), with a link to the full
// Scope of this release reference page. Present-tense facts only, never a future promise or a
// date (scope.ts's own statements are already proven free of forbidden wording by
// tests/unit/site/landing-claims.test.ts).
import Link from 'next/link';
import { SCOPE_EXCLUSIONS } from '../../content/scope';

const LINK_CLASSES =
  'text-body font-normal text-accent-text underline-offset-4 hover:underline ' +
  'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

export function ScopeBlock() {
  const exclusions = SCOPE_EXCLUSIONS.filter((exclusion) => exclusion.showOnLanding);

  return (
    <section data-testid="scope-block" className="rounded-lg border border-hairline bg-surface-1 p-6">
      <h2 className="text-title font-semibold text-ink">What it does not do yet</h2>
      <ul className="mt-4 flex flex-col gap-2">
        {exclusions.map((exclusion) => (
          <li key={exclusion.id} className="text-body font-normal text-ink-secondary">
            {exclusion.statement}
          </li>
        ))}
      </ul>
      <Link href="/docs/reference/scope" className={`mt-4 inline-block ${LINK_CLASSES}`}>
        See full scope
      </Link>
    </section>
  );
}
