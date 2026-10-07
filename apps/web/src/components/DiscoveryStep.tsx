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
import type { ReactNode } from 'react';
import { Check, Clock, Minus, TriangleAlert, X, type LucideIcon } from 'lucide-react';
import type { DiscoveryCheckId } from '@noodara/domain/discovery';
import { cn, Disclosure, type Tone } from '@noodara/ui';
import { formatDuration, isStepResolved, type CheckState, type DiscoveryCheckView } from '../lib/discovery-progress';
import type { DiscoveryStepName } from '../lib/discovery-steps';

// UI-07 (08-UI-SPEC.md §7.4, §9 #11): raw checks arrive staggered 40ms per index in DOM order,
// never blocking interaction while the stagger plays. Capped at four checks' worth (the largest
// group -- Resources: cpu/memory/disk/uptime, D-06) so no step's own disclosure could ever produce
// a longer stagger than this file's own worst case, matching 08-16-PLAN.md's own "state the cap
// and the reasoning" convention for the identical technique on the servers list.
const CHECK_STAGGER_STEP_MS = 40;
const CHECK_STAGGER_MAX_DELAY_MS = 4 * CHECK_STAGGER_STEP_MS;

function checkStaggerDelayMs(index: number): number {
  return Math.min(index * CHECK_STAGGER_STEP_MS, CHECK_STAGGER_MAX_DELAY_MS);
}

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

// 13-20: words and caption lines use the AA-tuned --status-*-text tokens (the Field/RowMenu
// call-site precedent, WR-C-08): the plain semantic colors are icon/dot colors and fall below
// 4.5:1 as caption text in light (--status-error on white is 3.54:1).
const TONE_WORD_CLASSES: Record<Tone, string> = {
  ok: 'text-status-ok-text',
  warn: 'text-status-warn-text',
  error: 'text-status-error-text',
  idle: 'text-status-idle-text',
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
// the ids `severityFor` (discovery-progress.ts) can mark `warning` for. `docker_buildkit` (D-03)
// has no line: its check detail already carries the remediation (install docker-buildx-plugin).
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
  return check.durationMs === null ? check.detail : `${check.detail} · ${formatDuration(check.durationMs)}`;
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
  /** The step's own aggregate duration (D-09, `discovery-progress.ts`'s `stepDurationMs`) --
   *  `null` renders no duration at all rather than a guess (a step still mid-run, or one of the
   *  two connection-derived steps that carries no checks to sum). Optional/defaulted to `null` so
   *  every call site written before this plan keeps compiling unchanged. */
  readonly durationMs?: number | null;
}

export interface StepRowProps {
  /** The row's own test id (`discovery-step-<id>`, `deployment-step-<name>`). */
  readonly testId: string;
  /** Picks the icon, tone and pulse from the shared tables above. */
  readonly visual: CheckState;
  readonly label: string;
  /** The status word; defaults to the discovery word for `visual`. */
  readonly word?: string;
  readonly durationMs?: number | null;
  /** Whether this row's thread segment is inked in. */
  readonly threadFilled: boolean;
  readonly children?: ReactNode;
}

/**
 * 13-13: the step row both timelines share (discovery checklist, deployment narration) -- the
 * thread, icon, label, duration and status word. Extracted from DiscoveryStep so the deployment
 * steps reuse it instead of a copy. The running pulse is `motion-safe:` only (reduced motion keeps
 * the icon still).
 */
export function StepRow({ testId, visual, label, word = STATE_WORDS[visual], durationMs = null, threadFilled, children }: StepRowProps) {
  const tone = STATE_TONE[visual];
  const Icon = STATE_ICON[visual];

  return (
    <div
      data-testid={testId}
      data-severity={visual}
      data-step-row="true"
      className="group/step relative flex flex-col gap-1.5 border-b border-hairline py-3 last:border-b-0"
    >
      {/* Timeline thread (UI-08 D-09, 08-UI-SPEC.md §8.1): a 1px hairline track linking this row's
          marker to the next one, with an overlaid ink line that fills via `scale-y-*` (transform,
          never `height`/`top`/`margin`, §9 #11) the instant this step resolves. 13-20: it starts
          4px below this row's icon (py-3 + a 20px headline line: the icon spans 14-30px, so 34px)
          and stops 4px above the next row's icon (-10px), never crossing either; the last row has
          no next marker and draws none. */}
      <div
        aria-hidden="true"
        data-step-thread=""
        className="absolute top-8.5 -bottom-2.5 left-2 w-px bg-hairline group-last/step:hidden"
      >
        <div
          className={cn(
            'h-full w-full origin-top bg-ink motion-safe:transition-transform motion-safe:duration-[var(--duration-panel)] motion-safe:ease-[var(--ease-out)]',
            threadFilled ? 'scale-y-100' : 'scale-y-0',
          )}
        />
      </div>

      <div className="flex items-center gap-2">
        <Icon
          aria-label={word}
          size={16}
          strokeWidth={1.5}
          className={cn('shrink-0', TONE_TEXT_CLASSES[tone], visual === 'running' && 'motion-safe:animate-pulse')}
        />
        <span className="flex-1 text-headline font-semibold text-ink">{label}</span>
        {durationMs === null ? null : (
          <span
            data-testid="step-duration"
            className="font-mono text-mono tabular-nums text-ink-tertiary"
          >
            {formatDuration(durationMs)}
          </span>
        )}
        <span className={cn('text-caption', TONE_WORD_CLASSES[tone])}>{word}</span>
      </div>

      {children}
    </div>
  );
}

export function DiscoveryStep({ stepId, label, state, checks, sshUser, durationMs = null }: DiscoveryStepProps) {
  // UI-08/D-09: this row's own thread segment inks in (`scale-y-100`) once `buildChecklist` has
  // already resolved it -- never a height animation (§9 #11), never a second progress
  // computation. `isStepResolved` is the exact same function `DiscoverySection`'s own
  // `completedFraction` sums over, imported rather than re-derived here.
  const threadFilled = isStepResolved(state);
  const consequenceLines = checks
    .filter((check) => check.state === 'warning')
    .map((check) => consequenceLineFor(check, sshUser))
    .filter((line): line is string => line !== null);

  return (
    <StepRow
      testId={`discovery-step-${stepId}`}
      visual={state}
      label={label}
      durationMs={durationMs}
      threadFilled={threadFilled}
    >
      {consequenceLines.map((line, index) => (
        <p key={`${stepId}-consequence-${String(index)}`} className="pl-6 text-caption text-status-warn-text">
          {line}
        </p>
      ))}

      {checks.length > 0 ? (
        <div className="pl-6">
          <Disclosure title={`${String(checks.length)} check${checks.length === 1 ? '' : 's'}`}>
            <div className="flex flex-col gap-2 pt-2">
              {checks.map((check, index) => {
                const checkTone = STATE_TONE[check.state];
                return (
                  <div
                    key={check.id}
                    data-testid={`discovery-check-${check.id}`}
                    data-entering="true"
                    className="flex flex-col gap-0.5 motion-safe:transition-[opacity,transform] motion-safe:duration-[var(--duration-panel)] motion-safe:ease-[var(--ease-out)] motion-safe:starting:translate-y-1 motion-safe:starting:opacity-0"
                    style={{ transitionDelay: `${String(checkStaggerDelayMs(index))}ms` }}
                  >
                    {/* UI-07/§9: staggered but never blocking -- no CSS rule that blocks pointer input, above or
                        anywhere in this row while its own entrance transition plays. */}
                    <div className="flex items-center gap-2 text-caption">
                      <span data-mono="true" className="text-mono text-ink-secondary">
                        {check.id}
                      </span>
                      <span className={TONE_WORD_CLASSES[checkTone]}>{STATE_WORDS[check.state]}</span>
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
    </StepRow>
  );
}
