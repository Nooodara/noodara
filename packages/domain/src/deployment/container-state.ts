// Parser for `docker inspect --type container --format '{{json .State}}' -- <name>` (ADR 0008 G4).
// Pure and never throws: malformed input becomes a typed `unparseable` result.

export const DOCKER_CONTAINER_STATES = Object.freeze([
  "created",
  "running",
  "paused",
  "restarting",
  "removing",
  "exited",
  "dead",
] as const);

export type DockerContainerState = (typeof DOCKER_CONTAINER_STATES)[number];

export function isDockerContainerState(
  value: unknown,
): value is DockerContainerState {
  return (
    typeof value === "string" &&
    (DOCKER_CONTAINER_STATES as readonly string[]).includes(value)
  );
}

export type ContainerStateResult =
  | {
      readonly kind: "ok";
      readonly status: DockerContainerState;
      readonly running: boolean;
      readonly exitCode: number;
      readonly oomKilled: boolean;
      readonly startedAt: string;
      readonly finishedAt: string;
    }
  | { readonly kind: "unparseable"; readonly reason: string };

export function parseContainerState(json: string): ContainerStateResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json.trim()) as unknown;
  } catch {
    return { kind: "unparseable", reason: "State was not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "unparseable", reason: "State JSON was not an object" };
  }
  const s = parsed as Record<string, unknown>;
  const { Status, Running, ExitCode, OOMKilled, StartedAt, FinishedAt } = s;
  if (!isDockerContainerState(Status)) {
    return {
      kind: "unparseable",
      reason: "State.Status missing or not a known container state",
    };
  }
  if (typeof Running !== "boolean") {
    return {
      kind: "unparseable",
      reason: "State.Running missing or not a boolean",
    };
  }
  if (typeof ExitCode !== "number") {
    return {
      kind: "unparseable",
      reason: "State.ExitCode missing or not a number",
    };
  }
  if (typeof OOMKilled !== "boolean") {
    return {
      kind: "unparseable",
      reason: "State.OOMKilled missing or not a boolean",
    };
  }
  if (typeof StartedAt !== "string" || typeof FinishedAt !== "string") {
    return {
      kind: "unparseable",
      reason: "State.StartedAt/FinishedAt missing or not strings",
    };
  }
  return {
    kind: "ok",
    status: Status,
    running: Running,
    exitCode: ExitCode,
    oomKilled: OOMKilled,
    startedAt: StartedAt,
    finishedAt: FinishedAt,
  };
}
