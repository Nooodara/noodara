import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderUi, screen, userEvent, waitFor } from '@noodara/ui/testing';
import { SettingsGroups } from './SettingsGroups';
import type { ConfigResponse } from '../lib/settings-rows';
import * as sessionUser from '../lib/session-user';
import * as appearance from '../lib/appearance';

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

const NO_FORM_CONTROL_ROLES = ['spinbutton', 'checkbox', 'switch'] as const;

beforeEach(() => {
  vi.spyOn(sessionUser, 'useSessionUser').mockReturnValue({ name: 'Ada Lovelace', email: 'ada@noodara.test' });
  vi.spyOn(sessionUser, 'useAccountPreferences').mockReturnValue({
    theme: 'auto',
    reduceMotion: 'system',
    density: 'comfortable',
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SettingsGroups', () => {
  it('renders group order Account -> Appearance -> Instance -> Advanced', () => {
    renderUi(<SettingsGroups config={buildConfig()} />);

    const groups = screen.getAllByTestId(
      /settings-account-group|settings-appearance-group|settings-instance-group|settings-advanced-disclosure/,
    );
    expect(groups.map((el) => el.getAttribute('data-testid'))).toEqual([
      'settings-account-group',
      'settings-appearance-group',
      'settings-instance-group',
      'settings-advanced-disclosure',
    ]);
  });

  it('renders the Account rows with Name/Email values and the Password row with no value text', () => {
    renderUi(<SettingsGroups config={buildConfig()} />);

    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByTestId('account-edit-name')).toHaveTextContent('Edit');

    expect(screen.getByText('Email')).toBeInTheDocument();
    expect(screen.getByText('ada@noodara.test')).toBeInTheDocument();
    expect(screen.getByTestId('account-edit-email')).toHaveTextContent('Edit');

    expect(screen.getByText('Password')).toBeInTheDocument();
    expect(screen.getByTestId('account-edit-password')).toHaveTextContent('Change');
    expect(screen.queryByText('••••••••')).not.toBeInTheDocument();
  });

  it('opens the name sheet with the current name when account-edit-name is clicked', async () => {
    const user = userEvent.setup();
    renderUi(<SettingsGroups config={buildConfig()} />);

    await user.click(screen.getByTestId('account-edit-name'));

    expect(screen.getByTestId('account-name-sheet')).toBeInTheDocument();
    expect(screen.getByTestId('account-name-input')).toHaveValue('Ada Lovelace');
  });

  it('opens the password sheet when account-edit-password is clicked', async () => {
    const user = userEvent.setup();
    renderUi(<SettingsGroups config={buildConfig()} />);

    await user.click(screen.getByTestId('account-edit-password'));

    expect(screen.getByTestId('account-password-sheet')).toBeInTheDocument();
  });

  it('renders the account-password-notice above the Account group after the password sheet reports sessionsRevoked, and dismissing hides it', async () => {
    const user = userEvent.setup();
    renderUi(<SettingsGroups config={buildConfig()} />);

    await user.click(screen.getByTestId('account-edit-password'));
    await user.type(screen.getByTestId('account-current-password-input'), 'CurrentPassw0rd!');
    await user.type(screen.getByTestId('account-new-password-input'), 'NewPassw0rd!123');
    await user.type(screen.getByTestId('account-confirm-password-input'), 'NewPassw0rd!123');

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ sessionsRevoked: 2 }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await user.click(screen.getByTestId('account-password-save'));

    await waitFor(() => {
      expect(screen.getByTestId('account-password-notice')).toHaveTextContent(
        'Password updated. 2 other sessions were signed out.',
      );
    });

    const notice = screen.getByTestId('account-password-notice');
    const accountGroup = screen.getByTestId('settings-account-group');
    expect(notice.compareDocumentPosition(accountGroup) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('account-password-notice')).not.toBeInTheDocument();

    vi.unstubAllGlobals();
  });

  it('renders the three Appearance SegmentedControls with the right labels and current values', () => {
    renderUi(<SettingsGroups config={buildConfig()} />);

    expect(screen.getByTestId('settings-theme-control')).toBeInTheDocument();
    expect(screen.getByTestId('settings-reduce-motion-control')).toBeInTheDocument();
    expect(screen.getByTestId('settings-density-control')).toBeInTheDocument();
    expect(screen.getByText('Theme')).toBeInTheDocument();
    expect(screen.getByText('Reduce motion')).toBeInTheDocument();
    expect(screen.getByText('Density')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Auto' })).toHaveAttribute('data-state', 'checked');
    expect(screen.getByRole('radio', { name: 'System' })).toHaveAttribute('data-state', 'checked');
    expect(screen.getByRole('radio', { name: 'Comfortable' })).toHaveAttribute('data-state', 'checked');
  });

  it('calls updateAppearancePreference with the right key/value when a segment is selected', async () => {
    const user = userEvent.setup();
    const updateSpy = vi.spyOn(appearance, 'updateAppearancePreference').mockResolvedValue({ ok: true });
    renderUi(<SettingsGroups config={buildConfig()} />);

    await user.click(screen.getByRole('radio', { name: 'Dark' }));

    expect(updateSpy).toHaveBeenCalledWith('theme', 'dark');
  });

  it('renders a Banner and keeps the reverted value when updateAppearancePreference fails', async () => {
    const user = userEvent.setup();
    vi.spyOn(appearance, 'updateAppearancePreference').mockResolvedValue({
      ok: false,
      message: "Couldn't save your appearance settings. Try again.",
    });
    renderUi(<SettingsGroups config={buildConfig()} />);

    await user.click(screen.getByRole('radio', { name: 'Dark' }));

    await waitFor(() => {
      expect(screen.getByText("Couldn't save your appearance settings. Try again.")).toBeInTheDocument();
    });
  });

  it('has no settings-appearance-theme-toggle anywhere and no switch/toggle role', () => {
    renderUi(<SettingsGroups config={buildConfig()} />);

    expect(screen.queryByTestId('settings-appearance-theme-toggle')).not.toBeInTheDocument();
    for (const role of NO_FORM_CONTROL_ROLES) {
      expect(screen.queryAllByRole(role)).toHaveLength(0);
    }
  });

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
    expect(screen.queryAllByText('Set by an environment variable')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Advanced' }));

    expect(screen.getByText('Master key fingerprint')).toBeInTheDocument();
    expect(screen.getByText('Connect timeout')).toBeInTheDocument();
    expect(screen.getByText('Command timeout')).toBeInTheDocument();
    expect(screen.getByText('Discovery timeout')).toBeInTheDocument();
    expect(screen.getByText('Worker concurrency')).toBeInTheDocument();
    expect(screen.getAllByText('Set by an environment variable')).toHaveLength(5);
  });

  it('gives every Instance/Advanced row a px-4 horizontal inset', async () => {
    const user = userEvent.setup();
    renderUi(<SettingsGroups config={buildConfig()} />);
    await user.click(screen.getByRole('button', { name: 'Advanced' }));

    const publicUrlRow = screen.getByTestId('settings-row-public-url');
    expect(publicUrlRow.className).toMatch(/\bpx-4\b/);
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
  });
});
