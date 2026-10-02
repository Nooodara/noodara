// Confirmed remote kill of a supervised operation (11-14, D-04, ADR 0008 G2, T-11-41). Closing a
// channel or the connection never stops the remote process (measured), so cancel and timeout must
// go through this primitive. Sequence, as accepted in ADR 0008:
//   1. process.kill_group: `kill -s TERM -- "-$pgid"` on the group recorded by `setsid -w`;
//   2. if the group is still alive after 2 s and a container is known, docker.kill it (ADR 0008
//      measured no such container during a BuildKit build: killing the CLI cancels the step);
//   3. success only when process.group_alive reports the group absent in ps (exit 1).
// It never throws: every failure ends as `confirmed: false`, and nothing remote reaches the result.
import type { Redactor } from '@noodara/domain/security';
import type { ContainerName, DeployRunPath, DockerObjectId } from '@noodara/domain/validators';
import type { RemoteCommand } from './commands/index.js';
import { dockerKill } from './commands/docker-deploy.js';
import { groupAlive, killGroup } from './commands/workspace.js';
import type { SshDeploySession, StreamResult } from './ssh-port.js';

/** ADR 0008 G2: docker kill only if a container is still alive 2 s after the group kill. */
export const DOCKER_KILL_GRACE_MS = 2_000;
/** Each step prints at most a line or two; anything larger is not ours to read. */
const STEP_MAX_TOTAL_BYTES = 4_096;
const STEP_MAX_LINE_BYTES = 1_024;
/** process.group_alive exit codes: 0 = a member is alive, 1 = none (pgrep found nothing). */
const GROUP_ABSENT_EXIT_CODE = 1;

export type KillStep = 'kill_group' | 'docker_kill';

export interface KillSupervisedOperationInput {
  /** The stream channel may still be open: the kill runs on its own channels. */
  readonly session: SshDeploySession;
  readonly pidFile: DeployRunPath;
  readonly buildContainer: ContainerName | DockerObjectId | null;
  /** Total budget, kill included; every remote step is bounded by what is left of it. */
  readonly confirmTimeoutMs: number;
  readonly pollIntervalMs: number;
  /** The session redacts step output; nothing remote is returned, so nothing else needs it. */
  readonly redactor: Redactor;
}

export interface KillSupervisedOperationResult {
  readonly confirmed: boolean;
  readonly steps: readonly KillStep[];
  readonly elapsedMs: number;
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Only a completed group_alive with exit 1 proves absence. Exit 2 (pidfile unreadable), a
 *  missing exit code or a timed-out probe proves nothing. */
function reportsAbsent(probe: StreamResult): boolean {
  return probe.outcome === 'completed' && probe.exitCode === GROUP_ABSENT_EXIT_CODE;
}

export async function killSupervisedOperation(
  input: KillSupervisedOperationInput,
): Promise<KillSupervisedOperationResult> {
  const { session, pidFile, buildContainer, confirmTimeoutMs, pollIntervalMs } = input;
  const startedAt = Date.now();
  const deadline = startedAt + confirmTimeoutMs;
  const steps: KillStep[] = [];
  const done = (confirmed: boolean): KillSupervisedOperationResult => ({
    confirmed,
    steps: [...steps],
    elapsedMs: Date.now() - startedAt,
  });

  if (!isPositiveInteger(confirmTimeoutMs) || !isPositiveInteger(pollIntervalMs)) return done(false);

  const run = (command: RemoteCommand, budgetMs: number): Promise<StreamResult> =>
    session.stream(command, {
      maxDurationMs: budgetMs,
      idleTimeoutMs: budgetMs,
      maxTotalBytes: STEP_MAX_TOTAL_BYTES,
      maxLineBytes: STEP_MAX_LINE_BYTES,
      onChunk: () => {
        // Step output is never needed: the exit code is the answer.
      },
    });

  try {
    steps.push('kill_group');
    // The exit code is not checked: a group that is already gone makes `kill` fail, and only
    // group_alive decides the outcome.
    await run(killGroup(pidFile), confirmTimeoutMs);

    let dockerKilled = false;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return done(false);
      if (reportsAbsent(await run(groupAlive(pidFile), remaining))) return done(true);

      if (!dockerKilled && buildContainer !== null && Date.now() - startedAt >= DOCKER_KILL_GRACE_MS) {
        dockerKilled = true;
        steps.push('docker_kill');
        const left = deadline - Date.now();
        if (left <= 0) return done(false);
        // Exit code ignored for the same reason as the group kill; poll again at once.
        await run(dockerKill(buildContainer), left);
        continue;
      }

      const left = deadline - Date.now();
      if (left <= 0) return done(false);
      await wait(Math.min(pollIntervalMs, left));
    }
  } catch {
    // A transport or usage failure: the group's state is unknown, so the kill is unconfirmed.
    return done(false);
  }
}
