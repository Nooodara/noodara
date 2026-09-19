import { Button } from './Button.js';

export interface EmptyStateAction {
  readonly label: string;
  readonly onClick: () => void;
}

export interface EmptyStateProps {
  readonly title: string;
  readonly body: string;
  readonly action?: EmptyStateAction;
  readonly 'data-testid'?: string;
}

// EmptyState (skill SS5 "Vacio", 05-UI-SPEC.md Component Inventory) -- a title, one sentence and
// at most one button, no illustration anywhere (skill SS8's Don't list explicitly bans them in
// empty states). D-12's "una sola accion" is made structurally true rather than a convention:
// `action` is typed as a single optional object, never an array, so a caller cannot construct a
// two-action empty state without a real `tsc` error -- verified by this file's own sibling test
// via a `@ts-expect-error` case, not by review discipline alone.
export function EmptyState({ title, body, action, 'data-testid': testId }: EmptyStateProps) {
  return (
    <div data-testid={testId} className="flex flex-col items-center gap-2 py-12 text-center">
      <h2 className="text-title font-semibold text-ink">{title}</h2>
      <p className="text-body text-ink-secondary">{body}</p>
      {action ? (
        <div className="pt-2">
          <Button type="button" variant="primary" onClick={action.onClick}>
            {action.label}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
