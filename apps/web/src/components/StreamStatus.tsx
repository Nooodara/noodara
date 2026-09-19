// A subtle dot + "Reconnecting…" shown only while the shared SSE stream is disconnected
// (05-UI-SPEC.md SS6, T-5-52). On-screen values everywhere else keep their last-known state --
// this indicator never hides or blanks existing data, it only signals that it may be stale.
export interface StreamStatusProps {
  readonly connected: boolean;
}

export function StreamStatus({ connected }: StreamStatusProps) {
  if (connected) return null;

  return (
    <span
      role="status"
      aria-live="polite"
      data-testid="shell-stream-status"
      className="flex items-center gap-1.5 text-caption text-ink-tertiary"
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-status-warn motion-safe:animate-pulse" />
      Reconnecting…
    </span>
  );
}
