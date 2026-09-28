// 10-12-PLAN.md Round 1 (D-02a). Facts-only FAQ, native <details>/<summary> (zero new JS,
// native keyboard/screen-reader disclosure semantics -- no custom accordion component). Every
// answer is an existing DELIVERED_CAPABILITIES claim or the build-time license fact
// (readBuildInfo) -- deliberately never a SCOPE_EXCLUSIONS statement, because those intentionally
// contain the very "excluded terms" Landing.test.tsx's "no excluded term outside the scope block"
// test scans the whole page for; quoting one here would trip that test for the wrong reason (an
// exclusion statement mentioning "domains" outside ScopeBlock, say) rather than a real leak.
import { readBuildInfo } from '../../lib/build-info';
import { DELIVERED_CAPABILITIES, type CapabilityId } from '../../content/scope';

interface FaqItem {
  readonly question: string;
  readonly capabilityId?: CapabilityId;
}

const FAQ_ITEMS: readonly FaqItem[] = [
  { question: 'Does Noodara need an agent on my server?', capabilityId: 'connect-ssh' },
  { question: 'How does Noodara verify a new server?', capabilityId: 'fingerprint-trust' },
  { question: 'Are my credentials safe?', capabilityId: 'encrypted-credentials' },
  { question: 'What happens after I add a server?', capabilityId: 'discovery' },
  { question: 'Which Ubuntu versions does Noodara support?', capabilityId: 'install' },
];

function claimFor(id: CapabilityId): string {
  const entry = DELIVERED_CAPABILITIES.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`FAQSection: unknown capability id "${id}"`);
  return entry.claim;
}

const SUMMARY_CLASSES =
  'flex cursor-pointer list-none items-center justify-between gap-4 text-headline font-semibold text-ink outline-none ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

// A visible expand/collapse affordance -- `list-none` above removes the browser's own <details>
// triangle, so this chevron replaces it (never remove an affordance without a replacement).
// Rotates 180deg when the parent <details> is open, via Tailwind's `group-open:` variant.
function DisclosureChevron() {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      className="shrink-0 text-ink-secondary transition-transform duration-[var(--duration-micro)] ease-[var(--ease-standard)] group-open:rotate-180"
    >
      <path d="M4 6 L8 10 L12 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function FAQSection() {
  const { license } = readBuildInfo();

  return (
    <div data-testid="faq-section" className="flex flex-col gap-6">
      <h2 className="text-title font-semibold text-ink">Frequently asked questions</h2>
      <div className="flex flex-col divide-y divide-hairline border-t border-b border-hairline">
        {FAQ_ITEMS.map((item) => (
          <details key={item.question} className="group py-4">
            <summary className={SUMMARY_CLASSES}>
              {item.question}
              <DisclosureChevron />
            </summary>
            <p className="mt-2 text-body font-normal text-ink-secondary">
              {item.capabilityId === undefined ? null : claimFor(item.capabilityId)}
            </p>
          </details>
        ))}
        <details className="group py-4">
          <summary className={SUMMARY_CLASSES}>
            Is Noodara open source?
            <DisclosureChevron />
          </summary>
          <p className="mt-2 text-body font-normal text-ink-secondary">Noodara is source-available under the {license} license.</p>
        </details>
      </div>
    </div>
  );
}
