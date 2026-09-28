// 10-06-PLAN.md Task 3: the in-context scope note used on affected docs pages (Service,
// Environment, Install per D-10). Renders one SCOPE_EXCLUSIONS statement verbatim, inside
// Fumadocs' own Callout (info type, re-skinned to --status-* tokens per UI-SPEC's Component
// Inventory), with a link to the full "Scope of this release" reference page. Renders no
// copy of its own beyond that statement and the link text.

import { Callout } from 'fumadocs-ui/components/callout';
import Link from 'next/link';
import { SCOPE_EXCLUSIONS, type ExclusionId } from '../../content/scope';

export function ScopeNote({ id }: { id: ExclusionId }) {
  const exclusion = SCOPE_EXCLUSIONS.find((entry) => entry.id === id);
  if (!exclusion) {
    throw new Error(`ScopeNote: unknown exclusion id "${id}"`);
  }

  return (
    <Callout type="info">
      {exclusion.statement} <Link href="/docs/reference/scope">See the full scope</Link>
    </Callout>
  );
}
