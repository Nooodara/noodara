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
import { CopyButton, Disclosure, LabelValue } from '@noodara/ui';
import { advancedRows, instanceRows, type ConfigResponse, type SettingsRow } from '../lib/settings-rows';

export interface SettingsGroupsProps {
  readonly config: ConfigResponse;
}

function SettingsRowView({ row }: { readonly row: SettingsRow }) {
  if (row.copyable) {
    return (
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <LabelValue label={row.label} value={row.value} mono />
        </div>
        <CopyButton value={row.value} label={`Copy ${row.label}`} />
      </div>
    );
  }

  return <LabelValue label={row.label} value={row.value} mono {...(row.caption !== undefined ? { caption: row.caption } : {})} />;
}

export function SettingsGroups({ config }: SettingsGroupsProps) {
  const instance = instanceRows(config);
  const advanced = advancedRows(config);

  return (
    <div className="flex flex-col gap-12">
      <section data-testid="settings-instance-group">
        <h2 className="mb-2 text-label uppercase text-ink-secondary">Instance</h2>
        <div className="flex flex-col">
          {instance.map((row) => (
            <SettingsRowView key={row.label} row={row} />
          ))}
        </div>
      </section>

      <Disclosure title="Advanced" data-testid="settings-advanced-disclosure">
        <div className="flex flex-col">
          {advanced.map((row) => (
            <SettingsRowView key={row.label} row={row} />
          ))}
        </div>
      </Disclosure>
    </div>
  );
}
