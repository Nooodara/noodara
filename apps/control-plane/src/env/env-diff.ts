// 23-02 (A3): does the env a deploy would apply now differ from the env of the running release?
// Compared field by field against the latest SUCCESS or ROLLED_BACK snapshot: keys, plain values,
// reference names and secret versions (a rotation makes it differ). Pure; no I/O.
import { parseRuntimeConfigSnapshot, runtimeConfigEnv, type RuntimeEnvEntry } from '@noodara/domain';

/** No SUCCESS or ROLLED_BACK deployment yet: nothing runs, so nothing differs. */
export const NO_RUNNING_DEPLOYMENT: unique symbol = Symbol('no-running-deployment');

function fingerprint(entry: RuntimeEnvEntry): string {
  return 'value' in entry ? `plain:${entry.value}` : `ref:${entry.secretRef}@${entry.secretVersion.toString()}`;
}

/**
 * `current` is the resolved env, or null when a reference does not resolve (a deploy would fail,
 * so it differs). `runningConfig` is the snapshot's raw jsonb; null (an older row) is an empty env.
 */
export function differsFromRunning(
  current: readonly RuntimeEnvEntry[] | null,
  runningConfig: unknown,
): boolean {
  if (runningConfig === NO_RUNNING_DEPLOYMENT) return false;
  if (current === null) return true;
  let runningEnv: readonly RuntimeEnvEntry[] = [];
  if (runningConfig !== null) {
    const parsed = parseRuntimeConfigSnapshot(runningConfig);
    if (!parsed.ok) return true;
    runningEnv = runtimeConfigEnv(parsed.value);
  }
  if (runningEnv.length !== current.length) return true;
  const byKey = new Map(runningEnv.map((entry) => [entry.key, fingerprint(entry)]));
  return current.some((entry) => byKey.get(entry.key) !== fingerprint(entry));
}
