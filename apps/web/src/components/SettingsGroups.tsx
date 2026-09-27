// The Settings screen's four groups (D-01, D-12, D-15, D-17, 09-UI-SPEC.md §1/§3/§7): `Account`
// (Name/Email/Password, each opening a per-field `Sheet`), `Appearance` (Theme/Reduce
// motion/Density, each a `SegmentedControl` on the single `updateAppearancePreference` write
// path), `Instance` (always expanded) and `Advanced` (collapsed `Disclosure`) -- both read-only,
// unchanged since Phase 5. `Instance`/`Advanced` rows still come straight from
// `settings-rows.ts`'s pure mapping and render no control of any kind (SET-06/D-17's structural
// guarantee: `SettingsRow` cannot carry a handler); `Account`'s rows come from the sibling
// `account-rows.ts` module instead, a deliberately distinct type. The screen's only authored
// moment stays the `Advanced` `Disclosure`'s expand/collapse (Phase 8 D-11) -- the password-change
// `Notice` and the Appearance controls are a plain fade/instant state change, never a second
// authored moment.
import { useRef, useState } from 'react';
import { Banner, CopyButton, Disclosure, InsetGroup, LabelValue, Notice, SegmentedControl } from '@noodara/ui';
import { Button } from '@noodara/ui';
import { DEFAULT_PREFERENCES, type Preferences } from '@noodara/domain/preferences';
import { accountRows } from '../lib/account-rows';
import { passwordNoticeMessage } from '../lib/account-form';
import { updateAppearancePreference, type AppearanceKey } from '../lib/appearance';
import { useAccountPreferences, useSessionUser } from '../lib/session-user';
import { advancedRows, instanceRows, type ConfigResponse, type SettingsRow } from '../lib/settings-rows';
import { AccountProfileSheet, type AccountProfileField } from './AccountProfileSheet';
import { AccountPasswordSheet } from './AccountPasswordSheet';

export interface SettingsGroupsProps {
  readonly config: ConfigResponse;
}

/** `"Master key fingerprint"` -> `"master-key-fingerprint"` -- a stable per-row test hook
 *  (05-UI-SPEC.md SS9's `data-testid` convention) derived from the row's own label rather than a
 *  second, hand-maintained id list that could drift out of sync with `settings-rows.ts`. */
function rowSlug(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function SettingsRowView({ row }: { readonly row: SettingsRow }) {
  const testId = `settings-row-${rowSlug(row.label)}`;

  if (row.copyable) {
    return (
      <div data-testid={testId} className="flex items-center gap-2 px-4">
        <div className="flex-1">
          <LabelValue label={row.label} value={row.value} mono />
        </div>
        <CopyButton value={row.value} label={`Copy ${row.label}`} />
      </div>
    );
  }

  return (
    <div className="px-4">
      <LabelValue
        data-testid={testId}
        label={row.label}
        value={row.value}
        mono
        {...(row.caption !== undefined ? { caption: row.caption } : {})}
      />
    </div>
  );
}

const ACCOUNT_ROW_CLASSES = 'flex items-center justify-between gap-4 px-4';

/** The `Account` group (SET-02/SET-03, D-01, 09-UI-SPEC.md §1). Each row's `Edit`/`Change` button
 *  captures its own native DOM element into a `triggerRef` at click time (`event.currentTarget`,
 *  09-UI-SPEC.md §5.2) rather than a forwarded React ref -- `Button` itself carries no `ref` prop,
 *  and the click handler already runs before `onOpenChange(true)`, satisfying the same "capture
 *  the trigger before opening" contract. */
function AccountGroup() {
  const user = useSessionUser();
  const rows = accountRows(user);
  const nameRow = rows.find((row) => row.field === 'name');
  const emailRow = rows.find((row) => row.field === 'email');

  const [openField, setOpenField] = useState<AccountProfileField | null>(null);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [notice, setNotice] = useState<{ readonly sessionsRevoked: number } | null>(null);

  const nameTriggerRef = useRef<HTMLElement | null>(null);
  const emailTriggerRef = useRef<HTMLElement | null>(null);
  const passwordTriggerRef = useRef<HTMLElement | null>(null);

  return (
    <>
      {notice !== null ? (
        <Notice
          message={passwordNoticeMessage(notice.sessionsRevoked)}
          onDismiss={() => {
            setNotice(null);
          }}
          data-testid="account-password-notice"
        />
      ) : null}

      <InsetGroup title="Account" data-testid="settings-account-group">
        <div className={ACCOUNT_ROW_CLASSES} style={{ height: 'var(--row-height)' }}>
          <span className="text-callout font-medium text-ink-secondary truncate">Name</span>
          <div className="flex items-center gap-3">
            <span className="text-body text-ink">{nameRow?.value ?? ''}</span>
            <Button
              variant="ghost"
              data-testid="account-edit-name"
              onClick={(event) => {
                nameTriggerRef.current = event.currentTarget;
                setOpenField('name');
              }}
            >
              Edit
            </Button>
          </div>
        </div>
        <div className={ACCOUNT_ROW_CLASSES} style={{ height: 'var(--row-height)' }}>
          <span className="text-callout font-medium text-ink-secondary truncate">Email</span>
          <div className="flex items-center gap-3">
            <span className="text-body text-ink">{emailRow?.value ?? ''}</span>
            <Button
              variant="ghost"
              data-testid="account-edit-email"
              onClick={(event) => {
                emailTriggerRef.current = event.currentTarget;
                setOpenField('email');
              }}
            >
              Edit
            </Button>
          </div>
        </div>
        <div className={ACCOUNT_ROW_CLASSES} style={{ height: 'var(--row-height)' }}>
          <span className="text-callout font-medium text-ink-secondary truncate">Password</span>
          <Button
            variant="ghost"
            data-testid="account-edit-password"
            onClick={(event) => {
              passwordTriggerRef.current = event.currentTarget;
              setPasswordOpen(true);
            }}
          >
            Change
          </Button>
        </div>
      </InsetGroup>

      <AccountProfileSheet
        field="name"
        initialValue={nameRow?.value ?? ''}
        open={openField === 'name'}
        onOpenChange={(open) => {
          setOpenField(open ? 'name' : null);
        }}
        returnFocusRef={nameTriggerRef}
      />
      <AccountProfileSheet
        field="email"
        initialValue={emailRow?.value ?? ''}
        open={openField === 'email'}
        onOpenChange={(open) => {
          setOpenField(open ? 'email' : null);
        }}
        returnFocusRef={emailTriggerRef}
      />
      <AccountPasswordSheet
        open={passwordOpen}
        onOpenChange={setPasswordOpen}
        onSaved={(sessionsRevoked) => {
          setNotice({ sessionsRevoked });
        }}
        returnFocusRef={passwordTriggerRef}
      />
    </>
  );
}

const APPEARANCE_ROW_CLASSES = 'flex items-center justify-between gap-4 px-4 py-[var(--row-height-padding-y)]';

/** The `Appearance` group (SET-04/SET-05, D-12/D-13/D-15, 09-UI-SPEC.md §3) -- three
 *  `SegmentedControl`s, every selection routed through `updateAppearancePreference` (P17's single
 *  write path). A failed save renders a `Banner`; `updateAppearancePreference` has already
 *  reverted both the applied preference and the store to the previous value by the time this
 *  component re-renders, so the control itself never needs its own optimistic-then-revert state. */
function AppearanceGroup() {
  const preferences = useAccountPreferences() ?? DEFAULT_PREFERENCES;
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleChange<K extends AppearanceKey>(key: K, value: Preferences[K]): Promise<void> {
    setErrorMessage(null);
    const result = await updateAppearancePreference(key, value);
    if (!result.ok) {
      setErrorMessage(result.message ?? "Couldn't save your appearance settings. Try again.");
    }
  }

  return (
    <>
      {errorMessage !== null ? <Banner message={errorMessage} /> : null}
      <InsetGroup title="Appearance" data-testid="settings-appearance-group">
        <div className={APPEARANCE_ROW_CLASSES}>
          <span className="text-callout font-medium text-ink-secondary">Theme</span>
          <SegmentedControl
            data-testid="settings-theme-control"
            value={preferences.theme}
            onValueChange={(value) => {
              void handleChange('theme', value);
            }}
            options={[
              { value: 'auto', label: 'Auto' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
          />
        </div>
        <div className={APPEARANCE_ROW_CLASSES}>
          <span className="text-callout font-medium text-ink-secondary">Reduce motion</span>
          <SegmentedControl
            data-testid="settings-reduce-motion-control"
            value={preferences.reduceMotion}
            onValueChange={(value) => {
              void handleChange('reduceMotion', value);
            }}
            options={[
              { value: 'system', label: 'System' },
              { value: 'on', label: 'On' },
              { value: 'off', label: 'Off' },
            ]}
          />
        </div>
        <div className={APPEARANCE_ROW_CLASSES}>
          <span className="text-callout font-medium text-ink-secondary">Density</span>
          <SegmentedControl
            data-testid="settings-density-control"
            value={preferences.density}
            onValueChange={(value) => {
              void handleChange('density', value);
            }}
            options={[
              { value: 'comfortable', label: 'Comfortable' },
              { value: 'compact', label: 'Compact' },
            ]}
          />
        </div>
      </InsetGroup>
    </>
  );
}

export function SettingsGroups({ config }: SettingsGroupsProps) {
  const instance = instanceRows(config);
  const advanced = advancedRows(config);

  return (
    <div className="flex flex-col gap-6">
      <AccountGroup />

      <AppearanceGroup />

      <InsetGroup title="Instance" data-testid="settings-instance-group">
        {instance.map((row) => (
          <SettingsRowView key={row.label} row={row} />
        ))}
      </InsetGroup>

      <Disclosure title="Advanced" data-testid="settings-advanced-disclosure">
        <InsetGroup>
          {advanced.map((row) => (
            <SettingsRowView key={row.label} row={row} />
          ))}
        </InsetGroup>
      </Disclosure>
    </div>
  );
}
