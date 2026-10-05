// Docker deploy templates (SVC-08, DEP-08, ROADMAP D8/D11/D12/D13, ADR 0008 G1/G2/G4). Branded
// inputs only, `--` before every positional, and no builder can emit build args, env vars,
// volumes, mounts, host namespaces or privileged flags. Every captured Docker failure exits 1
// except a port clash (125): callers classify stderr, never the code.
import type {
  BuildTarget,
  ContainerName,
  ContainerPort,
  DockerConfigDir,
  DockerObjectId,
  ImageRef,
  NetworkName,
  RegistryHost,
  RegistryUsername,
  RepoBuildPath,
  ResourceId,
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
