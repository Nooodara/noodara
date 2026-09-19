// RED-first for Task 3: the component-level half of "state is never colour-only" (SS8) -- every
// one of the seven severities renders its own status word as text, driven by a loop over the
// seven states so this cannot silently drift from `discovery-progress.ts`'s own `CHECK_STATES`.
import { describe, expect, it } from 'vitest';
import { renderUi, screen, userEvent, within } from '@noodara/ui/testing';
import { CHECK_STATES, type CheckState, type DiscoveryCheckView } from '../lib/discovery-progress';
import { DiscoveryStep } from './DiscoveryStep';

const STATE_WORDS: Record<CheckState, string> = {
  pass: 'Pass',
  warning: 'Warning',
  fail: 'Fail',
  not_applicable: 'Not applicable',
  skipped: 'Skipped',
  pending: 'Pending',
  running: 'Running',
};

describe('DiscoveryStep', () => {
  it.each(CHECK_STATES)('renders the status word as text with a matching data-severity for state=%s', (state) => {
    renderUi(<DiscoveryStep stepId="os" label="OS" state={state} checks={[]} sshUser="root" />);
    const row = screen.getByTestId('discovery-step-os');
    expect(row).toHaveAttribute('data-severity', state);
    expect(within(row).getByText(STATE_WORDS[state])).toBeInTheDocument();
  });

  it.each(CHECK_STATES)('gives the severity icon an aria-label repeating the same word for state=%s', (state) => {
    renderUi(<DiscoveryStep stepId="os" label="OS" state={state} checks={[]} sshUser="root" />);
    expect(screen.getByLabelText(STATE_WORDS[state])).toBeInTheDocument();
  });

  it('keeps raw checks absent from the document until the disclosure is activated', async () => {
    const checks: DiscoveryCheckView[] = [{ id: 'hostname', state: 'pass', detail: 'Hostname: srv-1', durationMs: 12 }];
    renderUi(<DiscoveryStep stepId="os" label="OS" state="pass" checks={checks} sshUser="root" />);

    expect(screen.queryByTestId('discovery-check-hostname')).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /1 check/ }));

    const checkRow = screen.getByTestId('discovery-check-hostname');
    expect(checkRow).toBeInTheDocument();
    expect(within(checkRow).getByText('hostname')).toBeInTheDocument();
    expect(within(checkRow).getByText('Hostname: srv-1 · 12ms')).toBeInTheDocument();
  });

  it('renders a detail containing angle brackets and a quote as escaped text, creating no element', async () => {
    const detail = '<img src=x onerror=alert(1)>"';
    const checks: DiscoveryCheckView[] = [{ id: 'docker_version', state: 'warning', detail, durationMs: 5 }];
    renderUi(<DiscoveryStep stepId="docker" label="Docker" state="warning" checks={checks} sshUser="deployer" />);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /1 check/ }));

    const checkRow = screen.getByTestId('discovery-check-docker_version');
    expect(checkRow.querySelector('img')).toBeNull();
    expect(within(checkRow).getByText(`${detail} · 5ms`)).toBeInTheDocument();
  });

  it('renders the SS5.5 consequence line for a warning check', () => {
    const warningChecks: DiscoveryCheckView[] = [
      { id: 'docker_group', state: 'warning', detail: 'User is not a member of the docker group.', durationMs: 4 },
    ];
    renderUi(<DiscoveryStep stepId="access" label="Access" state="warning" checks={warningChecks} sshUser="deployer" />);

    expect(
      screen.getByText('This user is not a member of the docker group. Run `usermod -aG docker deployer` on the server to fix this.'),
    ).toBeInTheDocument();
  });

  it('renders no consequence line for a pass check', () => {
    const passChecks: DiscoveryCheckView[] = [
      { id: 'docker_group', state: 'pass', detail: 'User is a member of the docker group.', durationMs: 3 },
    ];
    renderUi(<DiscoveryStep stepId="access" label="Access" state="pass" checks={passChecks} sshUser="deployer" />);

    expect(screen.queryByText(/Run `usermod -aG docker/)).not.toBeInTheDocument();
  });

  it('renders no disclosure trigger for a connection-derived step with zero checks', () => {
    renderUi(<DiscoveryStep stepId="ssh_reachable" label="SSH reachable" state="running" checks={[]} sshUser="root" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
