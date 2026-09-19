import type { ReactNode } from 'react';
import { cn } from './cn.js';
import { PLACEHOLDER } from './format.js';

export interface StatTileProps {
  readonly label: string;
  readonly value: string | number | null;
  readonly caption?: string;
  /** A 0..1 fraction driving the Disk tile's 1px meter. `null`/omitted renders no meter element
   *  at all -- the meter only exists for a tile that has one, never an empty stub. */
  readonly meterFraction?: number | null;
  readonly 'data-testid'?: string;
}

const ROOT_CLASSES = cn('flex flex-col gap-1 rounded-md border border-hairline bg-surface-1 p-5');
const LABEL_CLASSES = 'text-label uppercase text-ink-secondary';
const VALUE_CLASSES = cn('font-mono text-display tabular-nums text-ink');
const CAPTION_CLASSES = 'text-caption text-ink-tertiary';
const METER_TRACK_CLASSES = 'h-px w-full overflow-hidden rounded-full bg-surface-2';

function clampFraction(fraction: number): number {
  return Math.min(Math.max(fraction, 0), 1);
}

// StatTile (05-UI-SPEC.md SS2.5/D-11, skill SS4.6) -- the CPU/RAM/Disk/Uptime tile row. `label`
// at `--text-label`, `value` at `--text-display` mono with tabular numerals (`data-mono="true"`
// alongside the `tabular-nums` class, so a test can assert the contract from an attribute rather
// than a computed style). A `null` value always renders the shared `PLACEHOLDER`, never `0` --
// D-11/T-5-61's guarantee that an unknown fact is never misrepresented as a measured one. The
// optional `caption` slot is the "as of {relative time}" line every tile carries (only `Disk`
// gets `meterFraction`, the 1px meter this plan's must_haves name).
export function StatTile({ label, value, caption, meterFraction, 'data-testid': testId }: StatTileProps): ReactNode {
  const displayValue = value ?? PLACEHOLDER;
  const hasMeter = meterFraction !== null && meterFraction !== undefined;

  return (
    <div data-testid={testId} className={ROOT_CLASSES}>
      <span className={LABEL_CLASSES}>{label}</span>
      <span data-mono="true" className={VALUE_CLASSES}>
        {displayValue}
      </span>
      {caption !== undefined ? <span className={CAPTION_CLASSES}>{caption}</span> : null}
      {hasMeter ? (
        <div data-fraction={meterFraction} role="presentation" className={METER_TRACK_CLASSES}>
          <div className="h-full bg-accent" style={{ width: `${(clampFraction(meterFraction) * 100).toString(10)}%` }} />
        </div>
      ) : null}
    </div>
  );
}
