import * as RadioGroupPrimitive from '@radix-ui/react-radio-group';
import { cn } from './cn.js';

export interface SegmentedControlOption<T extends string> {
  readonly value: T;
  readonly label: string;
}

export interface SegmentedControlProps<T extends string> {
  readonly value: T;
  readonly onValueChange: (value: T) => void;
  readonly options: readonly [SegmentedControlOption<T>, SegmentedControlOption<T>, ...SegmentedControlOption<T>[]];
  readonly 'data-testid'?: string;
}

const GROUP_CLASSES = cn(
  'inline-flex items-center gap-0.5 rounded-sm border border-hairline bg-surface-2 p-0.5',
);

const ITEM_CLASSES = cn(
  'rounded-sm px-3.5 py-1 text-callout font-medium text-ink-secondary',
  'transition-[background-color,color] duration-[var(--duration-micro)] ease-[var(--ease-standard)]',
  'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
  'data-[state=checked]:bg-accent data-[state=checked]:text-on-accent',
  'disabled:pointer-events-none disabled:opacity-50',
);

// SegmentedControl (skill SS4.1's accent-indicator selected segment, 05-UI-SPEC.md Component
// Inventory) -- a Radix RadioGroup styled as segments. Roving tabindex, arrow-key handling and
// every ARIA role/state (radiogroup/radio/aria-checked) come entirely from the primitive; this
// component adds no keyboard handling of its own (grep-gated by this plan's acceptance
// criteria). `onValueChange` only fires when the primitive's own controllable-state value
// actually changes, so re-clicking the already-selected segment is already a no-op by
// construction, not something this component has to guard against separately.
export function SegmentedControl<T extends string>({
  value,
  onValueChange,
  options,
  ...rest
}: SegmentedControlProps<T>) {
  return (
    <RadioGroupPrimitive.Root
      {...rest}
      value={value}
      onValueChange={(next) => {
        onValueChange(next as T);
      }}
      className={GROUP_CLASSES}
    >
      {options.map((option) => (
        <RadioGroupPrimitive.Item key={option.value} value={option.value} className={ITEM_CLASSES}>
          {option.label}
        </RadioGroupPrimitive.Item>
      ))}
    </RadioGroupPrimitive.Root>
  );
}
