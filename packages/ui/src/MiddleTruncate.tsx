import { cn } from './cn.js';

export interface MiddleTruncateProps {
  readonly value: string;
  /** Characters always kept at the end (the part of a URL or path that tells values apart). */
  readonly tail?: number;
  readonly className?: string;
  readonly 'data-testid'?: string;
}

const DEFAULT_TAIL = 16;

// 14-13 (A2): a long technical value (repository URL, path) elided in the middle with CSS only:
// the head truncates with an ellipsis, the tail never shrinks, so the end of the value stays
// readable at any width and nothing is clipped by the card edge. The full value is on demand:
// `title` for pointer users, a visually hidden copy for screen readers (the visible halves are
// aria-hidden, so it is read once, whole). React renders it as text, never HTML.
export function MiddleTruncate({ value, tail = DEFAULT_TAIL, className, 'data-testid': testId }: MiddleTruncateProps) {
  if (value.length <= tail * 2) {
    return (
      <span data-testid={testId} title={value} className={cn('block min-w-0 truncate', className)}>
        {value}
      </span>
    );
  }

  return (
    <span data-testid={testId} title={value} className={cn('flex min-w-0 max-w-full', className)}>
      <span className="sr-only">{value}</span>
      <span aria-hidden="true" data-part="head" className="min-w-0 truncate">
        {value.slice(0, value.length - tail)}
      </span>
      <span aria-hidden="true" data-part="tail" className="shrink-0 whitespace-pre">
        {value.slice(-tail)}
      </span>
    </span>
  );
}
