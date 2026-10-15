// Docker deploy templates (SVC-08, DEP-08, ROADMAP D8/D11/D12/D13, ADR 0008 G1/G2/G4). Branded
// inputs only, `--` before every positional, and no builder can emit build args, env vars,
// volumes, mounts, host namespaces or privileged flags. Every captured Docker failure exits 1
// except a port clash (125): callers classify stderr, never the code.
import {
  validateHealthcheckConfig,
  type HealthcheckConfig,
} from "@noodara/domain/deployment";
import {
  containerNameFor,
  deploymentImageRefFor,
  networkNameFor,
  validateImageRef,
  validateResourceId,
  type BuildTarget,
  type ContainerName,
  type ContainerPort,
  type DockerConfigDir,
  type DockerObjectId,
  type ImageRef,
  type NetworkName,
  type RegistryHost,
  type RegistryUsername,
  type RepoBuildPath,
  type ResourceId,
  type ValidationResult,
} from "@noodara/domain/validators";
import { createRemoteCommand, type RemoteCommand } from "./remote-command.js";

const MAX_STOP_TIMEOUT_SECONDS = 300;
const MAX_LOG_TAIL = 10_000;
/** D8 defaults (research "Numbers That Are Reasoned Defaults"). */
const LOG_MAX_SIZE = "max-size=10m";
const LOG_MAX_FILE = "max-file=3";

function integerInRange(
  name: string,
  value: number,
  min: number,
  max: number,
): string {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(
      `${name} must be an integer from ${String(min)} to ${String(max)}`,
    );
  }
  return String(value);
}

function managedLabels(
  serviceId: ResourceId,
  deploymentId?: ResourceId,
): string[] {
  const labels = [
    "--label",
    "noodara.managed=true",
    "--label",
    `noodara.service_id=${serviceId}`,
  ];
  if (deploymentId !== undefined) {
    labels.push("--label", `noodara.deployment_id=${deploymentId}`);
  }
  return labels;
}

function command(
  name: RemoteCommand["name"],
  argv: readonly [string, ...string[]],
  options: { readonly stdin?: "secret"; readonly supervisable?: boolean } = {},
): RemoteCommand {
  return createRemoteCommand({
    name,
    argv,
    stdin: options.stdin ?? "none",
    supervisable: options.supervisable ?? false,
  });
}

/** G1: the password goes to stdin; credentials stay in the per-deployment config dir. */
export function dockerLogin(input: {
  readonly config: DockerConfigDir;
  readonly host: RegistryHost;
  readonly username: RegistryUsername;
}): RemoteCommand {
  return command(
    "docker.login",
    [
      "docker",
      "--config",
      input.config,
      "login",
      "--username",
      input.username,
      "--password-stdin",
      "--",
      input.host,
    ],
    { stdin: "secret" },
  );
}

export function dockerLogout(input: {
  readonly config: DockerConfigDir;
  readonly host: RegistryHost;
}): RemoteCommand {
  return command("docker.logout", [
    "docker",
    "--config",
    input.config,
    "logout",
    "--",
    input.host,
  ]);
}

/** `config: null` for a public image. */
export function dockerPull(input: {
  readonly config: DockerConfigDir | null;
  readonly image: ImageRef;
}): RemoteCommand {
  const configArgs = input.config === null ? [] : ["--config", input.config];
  return command(
    "docker.pull",
    ["docker", ...configArgs, "pull", "--", input.image],
    {
      supervisable: true,
    },
  );
}

/** BuildKit is the default builder (ADR 0008 G3); DOCKER_BUILDKIT is never set. */
export function dockerBuild(input: {
  readonly contextPath: RepoBuildPath;
  readonly dockerfilePath: RepoBuildPath;
  readonly image: ImageRef;
  readonly target: BuildTarget | null;
  readonly serviceId: ResourceId;
  readonly deploymentId: ResourceId;
}): RemoteCommand {
  const targetArgs = input.target === null ? [] : ["--target", input.target];
  return command(
    "docker.build",
    [
      "docker",
      "build",
      "--progress=plain",
      "--file",
      input.dockerfilePath,
      "--tag",
      input.image,
      ...targetArgs,
      ...managedLabels(input.serviceId, input.deploymentId),
      "--",
      input.contextPath,
    ],
    { supervisable: true },
  );
}

export function dockerImageRemove(image: ImageRef): RemoteCommand {
  return command("docker.image_remove", ["docker", "image", "rm", "--", image]);
}

export function dockerNetworkCreate(input: {
  readonly network: NetworkName;
  readonly serviceId: ResourceId;
}): RemoteCommand {
  return command("docker.network_create", [
    "docker",
    "network",
    "create",
    ...managedLabels(input.serviceId),
    "--",
    input.network,
  ]);
}

export function dockerNetworkRemove(network: NetworkName): RemoteCommand {
  return command("docker.network_remove", [
    "docker",
    "network",
    "rm",
    "--",
    network,
  ]);
}

/** `publishedPort: null` publishes nothing (the service is reached through its network). */
export function dockerCreate(input: {
  readonly container: ContainerName;
  readonly network: NetworkName;
  readonly image: ImageRef;
  readonly internalPort: ContainerPort;
  readonly publishedPort: ContainerPort | null;
  readonly serviceId: ResourceId;
  readonly deploymentId: ResourceId;
}): RemoteCommand {
  const publishArgs =
    input.publishedPort === null
      ? []
      : [
          "--publish",
          `${String(input.publishedPort)}:${String(input.internalPort)}`,
        ];
  return command("docker.create", [
    "docker",
    "create",
    "--name",
    input.container,
    "--network",
    input.network,
    "--restart",
    "unless-stopped",
    "--log-opt",
    LOG_MAX_SIZE,
    "--log-opt",
    LOG_MAX_FILE,
    ...managedLabels(input.serviceId, input.deploymentId),
    ...publishArgs,
    "--",
    input.image,
  ]);
}

export function dockerStart(container: ContainerName): RemoteCommand {
  return command("docker.start", ["docker", "start", "--", container]);
}

/** `--timeout`, not `--time`: Docker 29's CLI deprecates `--time` with a stderr warning. */
export function dockerStop(input: {
  readonly container: ContainerName;
  readonly timeoutSeconds: number;
}): RemoteCommand {
  const seconds = integerInRange(
    "timeoutSeconds",
    input.timeoutSeconds,
    0,
    MAX_STOP_TIMEOUT_SECONDS,
  );
  return command("docker.stop", [
    "docker",
    "stop",
    "--timeout",
    seconds,
    "--",
    input.container,
  ]);
}

export function dockerRestart(input: {
  readonly container: ContainerName;
  readonly timeoutSeconds: number;
}): RemoteCommand {
  const seconds = integerInRange(
    "timeoutSeconds",
    input.timeoutSeconds,
    0,
    MAX_STOP_TIMEOUT_SECONDS,
  );
  return command("docker.restart", [
    "docker",
    "restart",
    "--timeout",
    seconds,
    "--",
    input.container,
  ]);
}

export function dockerRemove(container: ContainerName): RemoteCommand {
  return command("docker.remove", ["docker", "rm", "--force", "--", container]);
}

/** G4: container state detail comes from inspect, not from `docker ps`. */
export function dockerInspectState(container: ContainerName): RemoteCommand {
  return command("docker.inspect", [
    "docker",
    "inspect",
    "--type",
    "container",
    "--format",
    "{{json .State}}",
    "--",
    container,
  ]);
}

/**
 * The tail form is a plain bounded command. The follow form never ends on its own, and closing the
 * channel does not stop it (ADR 0008), so it is supervisable: run it under process.supervise and
 * end it with killSupervisedOperation.
 */
export function dockerLogs(input: {
  readonly container: ContainerName;
  readonly tail: number;
  readonly follow: boolean;
}): RemoteCommand {
  const tail = integerInRange("tail", input.tail, 1, MAX_LOG_TAIL);
  return command(
    "docker.logs",
    [
      "docker",
      "logs",
      "--tail",
      tail,
      "--timestamps",
      ...(input.follow ? ["--follow"] : []),
      "--",
      input.container,
    ],
    { supervisable: input.follow },
  );
}

/** ADR 0008 G4, exactly: NDJSON, and `--size=false` is mandatory. */
export function dockerPs(): RemoteCommand {
  return command("docker.ps", [
    "docker",
    "ps",
    "--all",
    "--no-trunc",
    "--size=false",
    "--filter",
    "label=noodara.managed=true",
    "--format",
    "{{json .}}",
  ]);
}

/**
 * D-04 fallback for a `noodara.managed` container still alive after the group kill. ADR 0008 G2
 * measured no target during a BuildKit build (`docker ps` is empty), so this does not stop builds.
 */
export function dockerKill(
  target: ContainerName | DockerObjectId,
): RemoteCommand {
  return command("docker.kill", ["docker", "kill", "--", target]);
}

/**
 * 14-10 (D12): age-based BuildKit cache prune. Fixed argv, host-wide (the cache is shared by every
 * build on the server), never `--all`: images in use are untouched, only dangling cache older than
 * a week goes. No parameters, so no caller string reaches the command.
 */
export function dockerBuilderPrune(): RemoteCommand {
  return command("docker.builder_prune", [
    "docker",
    "builder",
    "prune",
    "--force",
    "--filter",
    "until=168h",
  ]);
}

// --- 17-01 (ADR 0010): healthcheck probes, the -prev container and per-service images ----------

declare const containerIpBrand: unique symbol;
/** An IPv4 address read from `docker inspect` (ADR 0010 A1), validated before every probe. */
export type ContainerIp = string & { readonly [containerIpBrand]: true };

const IPV4_OCTET = "(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])";
const IPV4 = new RegExp(`^${IPV4_OCTET}(\\.${IPV4_OCTET}){3}$`);

/** Strict dotted IPv4 (no leading zeros); never 0/8, loopback or multicast/reserved (>= 224). */
export function validateContainerIp(input: string): ValidationResult<ContainerIp> {
  if (typeof input === "string" && IPV4.test(input)) {
    const first = Number(input.split(".")[0]);
    if (first !== 0 && first !== 127 && first < 224) {
      return { ok: true, value: input as ContainerIp };
    }
  }
  return {
    ok: false,
    code: "CONTAINER_IP_INVALID",
    message: "Container IP must be a unicast IPv4 address",
  };
}

/**
 * ADR 0010 A1/H1/H2, frozen as written in contracts-v03.test.ts. $1 = container IP, $2 = port,
 * $3 = domain-validated path. Only the status line (at most 64 bytes) is read; only fixed words
 * and three status digits are ever printed, so a response body never reaches the output.
 */
export const PROBE_SCRIPTS = Object.freeze({
  http: String.raw`{ exec 3<>"/dev/tcp/$1/$2"; } 2>/dev/null || { echo "NOODARA_PROBE refused"; exit 0; }
printf 'GET %s HTTP/1.0\r\nHost: %s:%s\r\nUser-Agent: noodara-healthcheck/1\r\nAccept: */*\r\nConnection: close\r\n\r\n' "$3" "$1" "$2" >&3 2>/dev/null || { echo "NOODARA_PROBE error"; exit 0; }
IFS= read -r -n 64 line <&3 || [ -n "$line" ] || { echo "NOODARA_PROBE empty"; exit 0; }
line=${"$"}{line%$'\r'}
case $line in
  "HTTP/1."[01]" "[1-5][0-9][0-9]|"HTTP/1."[01]" "[1-5][0-9][0-9]" "*) echo "NOODARA_PROBE http ${"$"}{line:9:3}" ;;
  *) echo "NOODARA_PROBE malformed" ;;
esac`,
  tcp: String.raw`{ exec 3<>"/dev/tcp/$1/$2"; } 2>/dev/null && echo "NOODARA_PROBE open" || echo "NOODARA_PROBE refused"`,
});

/** A4: the exec output budget for one probe (ADR 0010 H1: 1 KiB). */
export const PROBE_OUTPUT_MAX_BYTES = 1024;
/** H1: hard cap, in seconds, for every -prev step (rename, start, rm, network connect, inspect). */
export const PREV_STEP_TIMEOUT_SECONDS = 30;
/** `$0` of the probe script: a fixed word so `$1..$3` stay the only caller values. */
const PROBE_ARGV0 = "noodara-probe";

export type HttpHealthcheckConfig = Extract<HealthcheckConfig, { type: "http" }>;
export type TcpHealthcheckConfig = Extract<HealthcheckConfig, { type: "tcp" }>;

/** Re-validates a (possibly force-cast) config; a builder never trusts its caller. */
function checkedProbe<T extends "http" | "tcp">(
  ip: ContainerIp,
  config: HealthcheckConfig,
  type: T,
): Extract<HealthcheckConfig, { type: T }> & { readonly ip: ContainerIp } {
  const result = validateHealthcheckConfig(config);
  if (!result.ok || result.value.type !== type) {
    throw new RangeError(`probe.${type} needs a valid ${type} healthcheck config`);
  }
  const address = validateContainerIp(ip);
  if (!address.ok) throw new RangeError(`probe.${type} needs a valid container IP`);
  return { ...(result.value as Extract<HealthcheckConfig, { type: T }>), ip: address.value };
}

/** `env -i` + `--noprofile --norc`: no session env, BASH_ENV, ~/.bashrc or proxy (ADR 0010 H2). */
function probeWrapper(probeTimeoutS: number): string[] {
  const seconds = integerInRange("probeTimeoutS", probeTimeoutS, 1, 30);
  return [
    "env",
    "-i",
    "PATH=/usr/bin:/bin",
    "timeout",
    "-k",
    "1",
    seconds,
    "bash",
    "--noprofile",
    "--norc",
    "-c",
  ];
}

export function probeHttp(input: {
  readonly ip: ContainerIp;
  readonly config: HttpHealthcheckConfig;
}): RemoteCommand {
  const probe = checkedProbe(input.ip, input.config, "http");
  return command("probe.http", [
    ...(probeWrapper(probe.probeTimeoutS) as [string, ...string[]]),
    PROBE_SCRIPTS.http,
    PROBE_ARGV0,
    probe.ip,
    String(probe.port),
    probe.path,
  ]);
}

export function probeTcp(input: {
  readonly ip: ContainerIp;
  readonly config: TcpHealthcheckConfig;
}): RemoteCommand {
  const probe = checkedProbe(input.ip, input.config, "tcp");
  return command("probe.tcp", [
    ...(probeWrapper(probe.probeTimeoutS) as [string, ...string[]]),
    PROBE_SCRIPTS.tcp,
    PROBE_ARGV0,
    probe.ip,
    String(probe.port),
  ]);
}

function derived<T>(result: ValidationResult<T>, what: string): T {
  if (!result.ok) throw new RangeError(`${what} needs a valid service id`);
  return result.value;
}

function serviceNames(serviceId: ResourceId): {
  readonly current: ContainerName;
  readonly previous: ContainerName;
  readonly network: NetworkName;
} {
  const current = derived(containerNameFor(serviceId), "a -prev template");
  return {
    current,
    previous: `${current}-prev` as ContainerName,
    network: derived(networkNameFor(serviceId), "a -prev template"),
  };
}

/** ADR 0010 A2: `noodara-<serviceId>-prev`. */
export function previousContainerNameFor(serviceId: ResourceId): ContainerName {
  return serviceNames(serviceId).previous;
}

function bounded(
  name: RemoteCommand["name"],
  seconds: number,
  argv: readonly string[],
): RemoteCommand {
  return command(name, ["timeout", "-k", "1", String(seconds), ...argv]);
}

/**
 * H1: never `--force`; Docker refuses (Conflict) when `-prev` already exists, and the caller
 * reports that explicitly instead of removing another version.
 */
export function dockerRenameToPrevious(serviceId: ResourceId): RemoteCommand {
  const names = serviceNames(serviceId);
  return bounded("docker.rename_to_prev", PREV_STEP_TIMEOUT_SECONDS, [
    "docker",
    "rename",
    "--",
    names.current,
    names.previous,
  ]);
}

export function dockerRenameFromPrevious(serviceId: ResourceId): RemoteCommand {
  const names = serviceNames(serviceId);
  return bounded("docker.rename_from_prev", PREV_STEP_TIMEOUT_SECONDS, [
    "docker",
    "rename",
    "--",
    names.previous,
    names.current,
  ]);
}

/** ADR 0010 A2: never while the new container exists (callers restore in the A2 order). */
export function dockerStartPrevious(serviceId: ResourceId): RemoteCommand {
  return bounded("docker.start_prev", PREV_STEP_TIMEOUT_SECONDS, [
    "docker",
    "start",
    "--",
    serviceNames(serviceId).previous,
  ]);
}

export function dockerStopPrevious(input: {
  readonly serviceId: ResourceId;
  readonly timeoutSeconds: number;
}): RemoteCommand {
  const previous = serviceNames(input.serviceId).previous;
  const seconds = integerInRange(
    "timeoutSeconds",
    input.timeoutSeconds,
    0,
    MAX_STOP_TIMEOUT_SECONDS,
  );
  return bounded(
    "docker.stop_prev",
    input.timeoutSeconds + PREV_STEP_TIMEOUT_SECONDS,
    ["docker", "stop", "--timeout", seconds, "--", previous],
  );
}

/** Only `-prev`, never forced: a running `-prev` is refused rather than killed. */
export function dockerRemovePrevious(serviceId: ResourceId): RemoteCommand {
  return bounded("docker.remove_prev", PREV_STEP_TIMEOUT_SECONDS, [
    "docker",
    "rm",
    "--",
    serviceNames(serviceId).previous,
  ]);
}

/** ADR 0010 A2 surprise: re-attach the restored container to its network while it is stopped. */
export function dockerNetworkConnect(serviceId: ResourceId): RemoteCommand {
  const names = serviceNames(serviceId);
  return bounded("docker.network_connect", PREV_STEP_TIMEOUT_SECONDS, [
    "docker",
    "network",
    "connect",
    "--",
    names.network,
    names.current,
  ]);
}

/** ADR 0010 A1: the IP on `noodara-net-<serviceId>` is read before every probe. */
export function dockerInspectNetworks(input: {
  readonly serviceId: ResourceId;
  readonly container: "current" | "previous";
}): RemoteCommand {
  const names = serviceNames(input.serviceId);
  return bounded("docker.inspect_networks", PREV_STEP_TIMEOUT_SECONDS, [
    "docker",
    "inspect",
    "--type",
    "container",
    "--format",
    "{{json .NetworkSettings.Networks}}",
    "--",
    input.container === "previous" ? names.previous : names.current,
  ]);
}

/**
 * 17-05: a rollback target's image must still be on the server. Prints only the image id; a
 * missing image is Docker's "No such image" (exit 1). Reads only, bounded like the -prev steps,
 * and re-validates the ref so a force-cast value never reaches a command line.
 */
export function dockerImageInspect(image: ImageRef): RemoteCommand {
  const checked = validateImageRef(image);
  if (!checked.ok) {
    throw new RangeError("docker.image_inspect needs a valid image reference");
  }
  return bounded("docker.image_inspect", PREV_STEP_TIMEOUT_SECONDS, [
    "docker",
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    "--",
    checked.value,
  ]);
}

/** Retention: only this service's own images (its repository and its label), as NDJSON. */
export function dockerListServiceImages(serviceId: ResourceId): RemoteCommand {
  const id = derived(validateResourceId(serviceId), "docker.image_list_service");
  return command("docker.image_list_service", [
    "docker",
    "image",
    "ls",
    "--no-trunc",
    "--filter",
    `reference=noodara/${id}`,
    "--filter",
    `label=noodara.service_id=${id}`,
    "--format",
    "{{json .}}",
  ]);
}

/** Never forced: an image used by a container (running or `-prev`) is refused by Docker. */
export function dockerRemoveServiceImage(input: {
  readonly serviceId: ResourceId;
  readonly deploymentId: ResourceId;
}): RemoteCommand {
  const image = derived(
    deploymentImageRefFor(input.serviceId, input.deploymentId),
    "docker.image_remove_service",
  );
  return command("docker.image_remove_service", [
    "docker",
    "image",
    "rm",
    "--",
    image,
  ]);
}
