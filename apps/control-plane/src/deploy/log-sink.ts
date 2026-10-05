// 12-11 (A6): the deploy pipeline writes its output through this port only. The real sink
// (chunked DB rows + `deployment.log_chunk` events) is 12-12; until then the worker uses the noop.
// Every entry is already redacted by the pipeline's per-run Redactor before it gets here.
import type { DeploymentLogPhase } from '@noodara/domain/deployment';

export interface DeploymentLogEntry {
  readonly phase: DeploymentLogPhase;
  readonly stream: 'stdout' | 'stderr' | 'system';
  /** Redacted text: one or more lines. */
  readonly text: string;
  /** Increases by one per entry across the whole deployment. */
  readonly seq: number;
}

export interface DeploymentLogSink {
  write(entry: DeploymentLogEntry): void;
  /** Called once when the deployment ends, after cleanup; must not throw. */
  close(): Promise<void>;
}

export const noopDeploymentLogSink: DeploymentLogSink = Object.freeze({
  write: () => {
    // Intentionally empty until 12-12.
  },
  close: () => Promise.resolve(),
});
