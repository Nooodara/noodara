// The Settings screen's own read-only groups (SET-01, 05-UI-SPEC.md SS2.7, D-16) -- Instance
// (always expanded: version, public URL with its own copy button) and Advanced (collapsed by
// default via `Disclosure`: master key fingerprint, the three SSH timeouts and worker
// concurrency, every row carrying the "Set by an environment variable" caption). Every value comes
// straight from `settings-rows.ts`'s pure mapping -- this component only renders rows, it never
// computes one itself, and it renders no control of any kind: the whole screen is plain text
// (D-16's "no edit affordance anywhere" rule, made structural by `SettingsRow`'s own shape).
//
// The public URL row is composed explicitly (`LabelValue` for label/value, a separate `CopyButton`
// beside it) rather than through `LabelValue`'s own built-in `copyable` prop, so this file visibly
// owns the one copy affordance this screen has -- `settings-rows.ts`'s `copyable` flag decides
// which row gets it, never more than the public URL.
import { CopyButton, Disclosure, InsetGroup, LabelValue, ThemeToggle } from '@noodara/ui';
import { advancedRows, instanceRows, type ConfigResponse, type SettingsRow } from '../lib/settings-rows';

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

  // 08-19-PLAN.md Task 3 (G3 adjustment round 1, item 1): same InsetGroup-row inset fix as
  // ServerFacts.tsx -- InsetGroup's own row wrapper carries no horizontal padding, so both the
  // copyable and the plain row shapes here now wrap in an explicit `px-4` themselves.
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

export function SettingsGroups({ config }: SettingsGroupsProps) {
  const instance = instanceRows(config);
  const advanced = advancedRows(config);

  return (
    <div className="flex flex-col gap-6">
      <InsetGroup title="Instance" data-testid="settings-instance-group">
        {instance.map((row) => (
          <SettingsRowView key={row.label} row={row} />
        ))}
      </InsetGroup>

      {/* 08-19-PLAN.md Task 3 (G3 adjustment round 1, item 5, D-05 change): the theme control
          moves here from the account menu -- an Appearance InsetGroup consistent with Instance,
          the "Appearance" label as a plain row (no `settings-rows.ts` entry backs it, this screen
          has no other manual row) and `ThemeToggle` itself, never a second write path onto its
          own `STORAGE_KEY`. UI-level only, per D-05: no server-side persistence is added here --
          Phase 9 owns that. */}
      <InsetGroup title="Appearance" data-testid="settings-appearance-group">
        <div className="flex items-center justify-between gap-4 px-4 py-2">
          <span className="text-caption text-ink-secondary">Appearance</span>
          <ThemeToggle data-testid="settings-appearance-theme-toggle" />
        </div>
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
