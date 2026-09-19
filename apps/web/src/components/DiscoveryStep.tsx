// One row of the Discovery section's six-step checklist (DISC-02, 05-UI-SPEC.md SS4.1/SS4.2,
// D-06/D-08). Purely presentational -- every severity/word/consequence-line decision is already
// resolved by `apps/web/src/lib/discovery-progress.ts`'s pure functions; this component only
// renders what it is handed. State is never colour-only (SS8): the status word is always in the
// DOM's text content, and the severity icon's `aria-label` repeats that same word for screen
// readers. Raw checks stay genuinely absent from the document (Disclosure's own Radix
// Collapsible unmount) until the step's disclosure is activated.
//
// The `running` icon's pulse uses Tailwind's `motion-safe:` variant (the same gate
// StatusPill.tsx's own CONNECTING pulse and Disclosure.tsx's chevron transition already use) --
// it compiles to `@media (prefers-reduced-motion: no-preference)`, so it degrades to a static,
// non-animated icon the instant the user's OS-level `prefers-reduced-motion` preference is on
// (SS4.3/SS8).
import { Check, Clock, Minus, TriangleAlert, X, type LucideIcon } from 'lucide-react';
import type { DiscoveryCheckId } from '@noodara/domain/discovery';
import { cn, Disclosure, type Tone } from '@noodara/ui';
import type { CheckState, DiscoveryCheckView } from '../lib/discovery-progress';
import type { DiscoveryStepName } from '../lib/discovery-steps';

// SS4.2's exact seven words -- driven by a lookup, never invented ad hoc at a render site.
const STATE_WORDS = {
  pass: 'Pass',
  warning: 'Warning',
  fail: 'Fail',
  not_applicable: 'Not applicable',
  skipped: 'Skipped',
  pending: 'Pending',
  running: 'Running',
} as const satisfies Record<CheckState, string>;

// SS4.2's own tone table, refined by the "running" state (still `--status-warn`, distinguished by
// the pulse alone -- SS4.2's own table entry for it).
const STATE_TONE = {
  pass: 'ok',
  warning: 'warn',
  fail: 'error',
  not_applicable: 'idle',
  skipped: 'idle',
  pending: 'idle',
  running: 'warn',
} as const satisfies Record<CheckState, Tone>;

const TONE_TEXT_CLASSES: Record<Tone, string> = {
  ok: 'text-status-ok',
  warn: 'text-status-warn',
  error: 'text-status-error',
  idle: 'text-ink-tertiary',
};

// SS4.1's exact five icons (check / triangle / x / minus / clock) -- `not_applicable`/`skipped`
// share Minus, `pending`/`running` share Clock (distinguished by the pulse, not a sixth icon).
const STATE_ICON = {
  pass: Check,
  warning: TriangleAlert,
  fail: X,
  not_applicable: Minus,
  skipped: Minus,
  pending: Clock,
  running: Clock,
} as const satisfies Record<CheckState, LucideIcon>;

// SS5.5, verbatim, keyed by the one `DiscoveryCheckId` each line can ever apply to -- these are
// exactly the ids `severityFor` (discovery-progress.ts) can ever mark `warning` for, so every
// warning check this component receives has a line here by construction.
const WARNING_CONSEQUENCE_COPY: Partial<Record<DiscoveryCheckId, string>> = {
  os_release: 'Outside the supported matrix (Ubuntu 22.04/24.04). Some features may not work as expected.',
  docker_version: 'Docker is not installed on this server. Install Docker to prepare it for future deployments.',
  docker_compose_version: 'The Docker Compose plugin is not installed on this server.',
  sudo: 'Passwordless sudo is not available for this user. Some setup steps may require manual configuration.',
  docker_group: 'This user is not a member of the docker group. Run `usermod -aG docker {sshUser}` on the server to fix this.',
};

function consequenceLineFor(check: DiscoveryCheckView, sshUser: string): string | null {
  const template = WARNING_CONSEQUENCE_COPY[check.id];
  if (template === undefined) return null;
  return template.replaceAll('{sshUser}', sshUser);
}

function formatCheckDetail(check: DiscoveryCheckView): string {
  if (check.detail === null) return '—';
  return check.durationMs === null ? check.detail : `${check.detail} · ${String(check.durationMs)}ms`;
}

export interface DiscoveryStepProps {
  readonly stepId: DiscoveryStepName;
  readonly label: string;
  readonly state: CheckState;
  /** Empty for the two connection-derived steps (`ssh_reachable`/`authenticated`) -- no
   *  `DiscoveryCheckId` backs either, so no disclosure is rendered for them. */
  readonly checks: readonly DiscoveryCheckView[];
  /** Substituted into the docker_group consequence line's `{sshUser}` placeholder (SS5.5). */
  readonly sshUser: string;
}

export function DiscoveryStep({ stepId, label, state, checks, sshUser }: DiscoveryStepProps) {
  const tone = STATE_TONE[state];
  const Icon = STATE_ICON[state];
  const word = STATE_WORDS[state];
  const consequenceLines = checks
    .filter((check) => check.state === 'warning')
    .map((check) => consequenceLineFor(check, sshUser))
    .filter((line): line is string => line !== null);

  return (
    <div
      data-testid={`discovery-step-${stepId}`}
      data-severity={state}
      className="flex flex-col gap-1.5 border-b border-hairline py-3 last:border-b-0"
    >
      <div className="flex items-center gap-2">
        <Icon
          aria-label={word}
          size={16}
          strokeWidth={1.5}
          className={cn('shrink-0', TONE_TEXT_CLASSES[tone], state === 'running' && 'motion-safe:animate-pulse')}
        />
        <span className="flex-1 text-headline font-semibold text-ink">{label}</span>
        <span className={cn('text-caption', TONE_TEXT_CLASSES[tone])}>{word}</span>
      </div>

      {consequenceLines.map((line, index) => (
        <p key={`${stepId}-consequence-${String(index)}`} className="pl-6 text-caption text-status-warn">
          {line}
        </p>
      ))}

      {checks.length > 0 ? (
        <div className="pl-6">
          <Disclosure title={`${String(checks.length)} check${checks.length === 1 ? '' : 's'}`}>
            <div className="flex flex-col gap-2 pt-2">
              {checks.map((check) => {
                const checkTone = STATE_TONE[check.state];
                return (
                  <div key={check.id} data-testid={`discovery-check-${check.id}`} className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-2 text-caption">
                      <span data-mono="true" className="text-mono text-ink-secondary">
                        {check.id}
                      </span>
                      <span className={TONE_TEXT_CLASSES[checkTone]}>{STATE_WORDS[check.state]}</span>
                    </div>
                    <span data-mono="true" className="text-mono text-ink-tertiary">
                      {formatCheckDetail(check)}
                    </span>
                  </div>
                );
              })}
            </div>
          </Disclosure>
        </div>
      ) : null}
    </div>
  );
}
