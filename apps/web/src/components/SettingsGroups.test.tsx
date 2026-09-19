import { describe, expect, it } from 'vitest';
import { renderUi, screen, userEvent } from '@noodara/ui/testing';
import { SettingsGroups } from './SettingsGroups';
import type { ConfigResponse } from '../lib/settings-rows';

function buildConfig(overrides: Partial<ConfigResponse> = {}): ConfigResponse {
  return {
    version: '0.4.2',
    publicUrl: 'https://noodara.example.test',
    masterKeyFingerprint: 'a1b2c3d4e5f6a7b8',
    sshTimeouts: { connectMs: 10000, commandMs: 30000, discoveryMs: 60000 },
    workerConcurrency: 5,
    ...overrides,
  };
}

const NO_FORM_CONTROL_ROLES = ['textbox', 'combobox', 'spinbutton', 'checkbox', 'switch'] as const;

describe('SettingsGroups', () => {
  it('renders the Instance group always expanded, both rows, exactly one copy button', () => {
    renderUi(<SettingsGroups config={buildConfig()} />);

    expect(screen.getByText('Version')).toBeInTheDocument();
    expect(screen.getByText('0.4.2')).toBeInTheDocument();
    expect(screen.getByText('Public URL')).toBeInTheDocument();
    expect(screen.getByText('https://noodara.example.test')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /copy/i })).toHaveLength(1);
  });

  it('keeps the five Advanced rows absent from the document until the disclosure is activated, then shows exactly five with the exact caption', async () => {
    const user = userEvent.setup();
    renderUi(<SettingsGroups config={buildConfig()} />);

    expect(screen.queryByText('Master key fingerprint')).not.toBeInTheDocument();
    expect(screen.queryByText('Connect timeout')).not.toBeInTheDocument();
    expect(screen.queryByText('Worker concurrency')).not.toBeInTheDocument();
    expect(screen.queryAllByText('Set by an environment variable')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Advanced' }));

    expect(screen.getByText('Master key fingerprint')).toBeInTheDocument();
    expect(screen.getByText('Connect timeout')).toBeInTheDocument();
    expect(screen.getByText('Command timeout')).toBeInTheDocument();
    expect(screen.getByText('Discovery timeout')).toBeInTheDocument();
    expect(screen.getByText('Worker concurrency')).toBeInTheDocument();
    expect(screen.getAllByText('Set by an environment variable')).toHaveLength(5);
  });

  it('carries data-mono="true" on exactly the seven rendered values across both groups', async () => {
    const user = userEvent.setup();
    const { container } = renderUi(<SettingsGroups config={buildConfig()} />);
    await user.click(screen.getByRole('button', { name: 'Advanced' }));

    expect(container.querySelectorAll('[data-mono="true"]')).toHaveLength(7);
  });

  it('exposes zero form-control roles and no save/apply/edit-named button anywhere on the screen', async () => {
    const user = userEvent.setup();
    renderUi(<SettingsGroups config={buildConfig()} />);
    await user.click(screen.getByRole('button', { name: 'Advanced' }));

    for (const role of NO_FORM_CONTROL_ROLES) {
      expect(screen.queryAllByRole(role)).toHaveLength(0);
    }
    expect(screen.queryAllByRole('button', { name: /save|apply|edit/i })).toHaveLength(0);
  });

  it('renders a short master key fingerprint digest and no 44-character base64-looking string anywhere', async () => {
    const user = userEvent.setup();
    const { container } = renderUi(<SettingsGroups config={buildConfig({ masterKeyFingerprint: 'a1b2c3d4e5f6a7b8' })} />);
    await user.click(screen.getByRole('button', { name: 'Advanced' }));

    expect(screen.getByText('a1b2c3d4e5f6a7b8')).toBeInTheDocument();
    expect(container.textContent ?? '').not.toMatch(/[A-Za-z0-9+/]{44}/);
  });

  it('renders second-suffixed timeout values, never a raw millisecond count', async () => {
    const user = userEvent.setup();
    renderUi(
      <SettingsGroups config={buildConfig({ sshTimeouts: { connectMs: 2500, commandMs: 10000, discoveryMs: 60000 } })} />,
    );
    await user.click(screen.getByRole('button', { name: 'Advanced' }));

    expect(screen.getByText('2.5s')).toBeInTheDocument();
    expect(screen.getByText('10s')).toBeInTheDocument();
    expect(screen.getByText('60s')).toBeInTheDocument();
    expect(screen.queryByText('2500')).not.toBeInTheDocument();
    expect(screen.queryByText('10000')).not.toBeInTheDocument();
    expect(screen.queryByText('60000')).not.toBeInTheDocument();
  });
});
