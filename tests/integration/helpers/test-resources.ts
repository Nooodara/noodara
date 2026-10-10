// Leak guard for `noodara.test=true` Docker resources (14-27).
//
// Ryuk is not a per-suite cleanup: testcontainers adopts any running Ryuk and its session id, so
// one Ryuk is shared by every process of a gate run and reaps only once all of them disconnect.
// It also exits without removing anything when its Docker list call exceeds its 10 s request
// timeout, and drops clients that connect while it prunes (docs/releases/v0.2-gate-logs/
// gate-14-15-leaked-containers.md). So every suite snapshots the labelled resources up front,
// removes whatever it added at teardown, and fails loudly naming what it had left behind.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const TEST_LABEL_FILTER = 'label=noodara.test=true';
const DOCKER_TIMEOUT_MS = 60_000;

export type DockerRunner = (args: readonly string[]) => Promise<string>;

export const dockerCli: DockerRunner = async (args) => {
  const { stdout } = await execFileAsync('docker', [...args], {
    timeout: DOCKER_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
};

export interface TestResourceSnapshot {
  readonly containers: readonly string[];
  readonly networks: readonly string[];
  readonly volumes: readonly string[];
}

export interface LeakReport {
  /** Resources added since the baseline, described before removal (`name (image, state)`). */
  readonly leaked: readonly string[];
  /** Resources still present after removal. */
  readonly survivors: readonly string[];
}

export interface ReapOptions {
  readonly docker?: DockerRunner;
  /** Wait this long after a non-empty first pass, then sweep again for in-flight creates. */
  readonly settleMs?: number;
}

const lines = (out: string): string[] =>
  out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');

export async function snapshotTestResources(docker: DockerRunner = dockerCli): Promise<TestResourceSnapshot> {
  const [containers, networks, volumes] = await Promise.all([
    docker(['ps', '-aq', '--no-trunc', '--filter', TEST_LABEL_FILTER]),
    docker(['network', 'ls', '-q', '--no-trunc', '--filter', TEST_LABEL_FILTER]),
    docker(['volume', 'ls', '-q', '--filter', TEST_LABEL_FILTER]),
  ]);
  return { containers: lines(containers), networks: lines(networks), volumes: lines(volumes) };
}

export function diffSnapshots(baseline: TestResourceSnapshot, current: TestResourceSnapshot): TestResourceSnapshot {
  const added = (before: readonly string[], now: readonly string[]): string[] => {
    const known = new Set(before);
    return now.filter((id) => !known.has(id));
  };
  return {
    containers: added(baseline.containers, current.containers),
    networks: added(baseline.networks, current.networks),
    volumes: added(baseline.volumes, current.volumes),
  };
}

const isEmpty = (s: TestResourceSnapshot): boolean =>
  s.containers.length === 0 && s.networks.length === 0 && s.volumes.length === 0;

export async function describeResources(
  resources: TestResourceSnapshot,
  docker: DockerRunner = dockerCli,
): Promise<string[]> {
  const out: string[] = [];
  for (const id of resources.containers) {
    const text = await docker(['inspect', '--format', '{{.Name}}|{{.Config.Image}}|{{.State.Status}}', id]).catch(
      () => '',
    );
    const [name, image, state] = text.trim().split('|');
    out.push(
      name !== undefined && name !== '' && image !== undefined && state !== undefined
        ? `container ${name.replace(/^\//, '')} (${image}, ${state})`
        : `container ${id.slice(0, 12)}`,
    );
  }
  for (const id of resources.networks) {
    const name = (await docker(['network', 'inspect', '--format', '{{.Name}}', id]).catch(() => '')).trim();
    out.push(`network ${name !== '' ? name : id.slice(0, 12)}`);
  }
  for (const name of resources.volumes) out.push(`volume ${name}`);
  return out;
}

async function removeResources(resources: TestResourceSnapshot, docker: DockerRunner): Promise<void> {
  // Containers first: a network or volume still in use cannot be removed.
  if (resources.containers.length > 0) {
    await docker(['rm', '-f', '-v', ...resources.containers]).catch(() => undefined);
  }
  for (const id of resources.networks) await docker(['network', 'rm', id]).catch(() => undefined);
  if (resources.volumes.length > 0) {
    await docker(['volume', 'rm', '-f', ...resources.volumes]).catch(() => undefined);
  }
}

/** Removes every labelled resource added since `baseline` and reports what it found. */
export async function reapTestResourcesSince(
  baseline: TestResourceSnapshot,
  options: ReapOptions = {},
): Promise<LeakReport> {
  const docker = options.docker ?? dockerCli;
  const leaked: string[] = [];
  const sweep = async (): Promise<boolean> => {
    const added = diffSnapshots(baseline, await snapshotTestResources(docker));
    if (isEmpty(added)) return false;
    leaked.push(...(await describeResources(added, docker)));
    await removeResources(added, docker);
    return true;
  };
  if ((await sweep()) && (options.settleMs ?? 0) > 0) {
    await new Promise((resolve) => setTimeout(resolve, options.settleMs));
    await sweep();
  }
  const left = diffSnapshots(baseline, await snapshotTestResources(docker));
  return { leaked: [...new Set(leaked)], survivors: await describeResources(left, docker) };
}

export function formatLeakReport(owner: string, report: LeakReport): string | null {
  if (report.leaked.length === 0 && report.survivors.length === 0) return null;
  const parts = [
    `${owner} left ${String(report.leaked.length)} noodara.test resource(s) behind; the leak guard removed them:`,
    ...report.leaked.map((r) => `  - ${r}`),
  ];
  if (report.survivors.length > 0) {
    parts.push('and could not remove:', ...report.survivors.map((r) => `  - ${r}`));
  }
  return parts.join('\n');
}

/** Teardown guard: reaps what `owner` added since `baseline`, then throws if it found anything. */
export async function assertNoLeakedTestResources(
  owner: string,
  baseline: TestResourceSnapshot,
  options: ReapOptions = {},
): Promise<void> {
  const message = formatLeakReport(owner, await reapTestResourcesSince(baseline, options));
  if (message !== null) throw new Error(message);
}

/**
 * Precheck: fails before a suite starts anything when labelled resources already exist, so a
 * previous run's leak is reported once, clearly, instead of as dozens of stray-container
 * assertion failures half an hour later. Never removes them: they are not this run's.
 */
export async function assertNoTestResources(context: string, docker: DockerRunner = dockerCli): Promise<void> {
  const existing = await snapshotTestResources(docker);
  if (isEmpty(existing)) return;
  const described = await describeResources(existing, docker);
  throw new Error(
    [
      `${context}: ${String(described.length)} noodara.test resource(s) already exist before the run:`,
      ...described.map((r) => `  - ${r}`),
      'They were left by an earlier run. Remove them, then retry:',
      `  docker rm -f -v $(docker ps -aq --filter ${TEST_LABEL_FILTER})`,
      `  docker network rm $(docker network ls -q --filter ${TEST_LABEL_FILTER})`,
      `  docker volume rm -f $(docker volume ls -q --filter ${TEST_LABEL_FILTER})`,
    ].join('\n'),
  );
}
