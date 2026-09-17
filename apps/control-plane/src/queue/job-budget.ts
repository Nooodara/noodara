// D-14: pure function deriving the BullMQ `connect-server` job's lockDuration/stalledInterval
// from the three effective SSH timeouts, with enough margin that a legitimate job is never marked
// stalled mid-SSH-session. Callers (worker.ts, /api/config) pass already-validated env.ts numbers
// in — this module must never import env.js itself, so it stays reusable and unit-testable in
// isolation from process.env / boot-time validation.
export interface JobLockTimeouts {
  readonly connectMs: number;
  readonly commandMs: number;
  readonly discoveryMs: number;
}

export function computeJobLockDurationMs(timeouts: JobLockTimeouts): number {
  // Per-attempt overhead: the SSH adapter retries a transient connect failure once (fase 2 D-10),
  // so the budget must cover two connect attempts, not one.
  const PER_ATTEMPT_OVERHEAD_MS = 2000;
  // Safety margin so a legitimate job is never marked stalled while still mid-SSH: covers
  // scheduling jitter and the gap between the last lock-renewal tick and the actual finish.
  const STALL_SAFETY_MARGIN_MS = 30000;

  // `commandMs` is accepted for a complete, self-documenting signature but intentionally not part
  // of the sum: `discoveryMs` (fase 2 D-08) already bounds the whole sequence of commands a
  // discovery run executes, so adding commandMs on top would double-count that budget. Do not
  // "fix" this by adding it in.
  return timeouts.connectMs * 2 + PER_ATTEMPT_OVERHEAD_MS + timeouts.discoveryMs + STALL_SAFETY_MARGIN_MS;
}
