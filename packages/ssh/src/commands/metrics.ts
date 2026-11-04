// Observability templates (ADR 0012, 27-01): host sample, container state and stats, bounded log
// window. Scripts are constants; caller values travel only as validated positional arguments
// (UUIDs, bounded integers, strict UTC timestamps). Every script runs bounded:
// `env -i PATH=... LC_ALL=C timeout -k 1 <s> bash --noprofile --norc -c '{ ... } 2>&1 | head -c <cap>'`.
// The inspect template selects only .State scalars, top-level scalars and .HostConfig.Memory, so no
// service env value can reach the output.
import {
  SAMPLE_OUTPUT_CAP_BYTES,
  compareLogTimestamps,
  containerNameFor,
  parseLogTimestamp,
  validateResourceId,
  type LogTimestamp,
  type ResourceId,
} from "@noodara/domain";
import { createRemoteCommand, type RemoteCommand } from "./remote-command.js";

const SCRIPT_PATH = "PATH=/usr/sbin:/usr/bin:/sbin:/bin";
const SCRIPT_ARGV0 = "noodara-metrics";

/** Timeout (seconds) and `head -c` cap (bytes) of each template; callers size their exec budget on it. */
export const OBSERVABILITY_LIMITS = Object.freeze({
  hostSample: Object.freeze({ timeoutSeconds: 15, capBytes: SAMPLE_OUTPUT_CAP_BYTES }),
  containerSample: Object.freeze({ timeoutSeconds: 30, capBytes: SAMPLE_OUTPUT_CAP_BYTES }),
  inspectState: Object.freeze({ timeoutSeconds: 20, capBytes: SAMPLE_OUTPUT_CAP_BYTES }),
  logsWindow: Object.freeze({ timeoutSeconds: 20, capBytes: 256 * 1024 + 4096 }),
});

export const HOST_SAMPLE_MAX_DELTA_SECONDS = 5;
/** Same bound as the API's log page (LOG_PAGE_MAX_ENTRIES). */
export const MAX_LOG_TAIL = 1000;
/** Same bound as the API's log line (LOG_LINE_MAX_LENGTH); longer lines are cut and flagged. */
export const LOGS_WINDOW_MAX_LINE_LENGTH = 8 * 1024;

/** ADR 0012 A2: one JSON object per container; Health.Log contributes exit codes only. */
export const INSPECT_STATE_TEMPLATE =
  '{"id":{{json .Id}},"name":{{json .Name}},"status":{{json .State.Status}},' +
  '"running":{{json .State.Running}},"restarting":{{json .State.Restarting}},' +
  '"restartCount":{{json .RestartCount}},"oomKilled":{{json .State.OOMKilled}},' +
  '"exitCode":{{json .State.ExitCode}},"startedAt":{{json .State.StartedAt}},' +
  '"finishedAt":{{json .State.FinishedAt}},' +
  '"health":{{with index .State "Health"}}{{json .Status}}{{else}}null{{end}},' +
  '"healthExitCodes":[{{with index .State "Health"}}{{range $i, $l := .Log}}{{if $i}},{{end}}{{$l.ExitCode}}{{end}}{{end}}],' +
  '"memoryLimit":{{json .HostConfig.Memory}}}';

export const STATS_TEMPLATE = "{{.ID}}\t{{.CPUPerc}}\t{{.MemUsage}}";

const MANAGED_FILTER = "label=noodara.managed=true";

export const METRICS_SCRIPTS = Object.freeze({
  /** ADR 0012 A1: CPU from two /proc/stat reads `$1` seconds apart, memory, df, uptime. */
  hostSample: [
    `printf 'CPU %s\\n' "$(head -n1 /proc/stat)"`,
    'sleep "$1"',
    `printf 'CPU %s\\n' "$(head -n1 /proc/stat)"`,
    "grep -E '^(MemTotal|MemAvailable):' /proc/meminfo | sed 's/^/MEM /'",
    "root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null) || root=",
    'if [ -n "$root" ]; then set -- / "$root"; else set -- /; fi',
    "df -B1 --output=target,size,used,avail \"$@\" | tail -n +2 | sed 's/^/DF /'",
    `printf 'UP %s\\n' "$(cat /proc/uptime)"`,
  ].join("\n"),
  /**
   * ADR 0012 A2: inspect every selected container, stats only the running ones. `$3` is a second
   * --filter (the service label, or the managed label again). A failed `docker ps` exits 3; a
   * container removed between ps and inspect/stats is a race, not a failure.
   */
  containerSample: [
    `all=$(docker ps -a -q --no-trunc --filter ${MANAGED_FILTER} --filter "$3") || exit 3`,
    `up=$(docker ps -q --no-trunc --filter ${MANAGED_FILTER} --filter "$3" --filter status=running) || exit 3`,
    "if [ -n \"$all\" ]; then docker inspect --type container --format \"$1\" -- $all | sed 's/^/I /'; fi",
    "if [ -n \"$up\" ]; then docker stats --no-stream --no-trunc --format \"$2\" -- $up | sed 's/^/S /'; fi",
    "true",
  ].join("\n"),
  /** The inspect half of containerSample; `$2` is the second --filter. */
  inspectState: [
    `all=$(docker ps -a -q --no-trunc --filter ${MANAGED_FILTER} --filter "$2") || exit 3`,
    "if [ -n \"$all\" ]; then docker inspect --type container --format \"$1\" -- $all | sed 's/^/I /'; fi",
    "true",
  ].join("\n"),
  /**
   * ADR 0012 A4: `--until` is never sent (tail applies before it); the parser filters it. stdout
   * lines get `O `, stderr lines `E `. A missing container prints one marker line and exits 0.
   */
  logsWindow: [
    "out=$(docker container inspect --format '{{.Id}}' -- \"$1\" 2>&1) || {",
    '  case "$out" in *"No such container"*) echo "NOODARA_LOGS missing"; exit 0;; esac',
    "  printf '%s\\n' \"$out\"",
    "  exit 3",
    "}",
    "{ { docker logs --timestamps --since \"$2\" --tail \"$3\" -- \"$1\" | sed -u 's/^/O /'; } 2>&1 1>&3 | sed -u 's/^/E /'; } 3>&1",
  ].join("\n"),
});

function script(
  name: RemoteCommand["name"],
  body: string,
  limits: { readonly timeoutSeconds: number; readonly capBytes: number },
  args: readonly string[],
): RemoteCommand {
  return createRemoteCommand({
    name,
    argv: [
      "env",
      "-i",
      SCRIPT_PATH,
      "LC_ALL=C",
      "timeout",
      "-k",
      "1",
      String(limits.timeoutSeconds),
      "bash",
      "--noprofile",
      "--norc",
      "-c",
      `set -o pipefail\n{\n${body}\n} 2>&1 | head -c ${String(limits.capBytes)}`,
      SCRIPT_ARGV0,
      ...args,
    ],
    stdin: "none",
    supervisable: false,
  });
}

function boundedInteger(value: unknown, min: number, max: number, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${field} must be an integer in [${String(min)}, ${String(max)}]`);
  }
  return value;
}

function serviceFilter(serviceId: ResourceId | undefined): string {
  if (serviceId === undefined) return MANAGED_FILTER;
  const id = validateResourceId(serviceId);
  if (!id.ok) throw new RangeError("serviceId must be a resource id");
  return `label=noodara.service_id=${id.value}`;
}

const UTC_TIMESTAMP =
  /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,9})?Z$/;

/** H1: RFC 3339 in UTC only (`Z`), a real calendar date, nothing else. */
function utcTimestamp(value: unknown, field: string): { text: string; at: LogTimestamp } {
  if (typeof value !== "string" || !UTC_TIMESTAMP.test(value)) {
    throw new RangeError(`${field} must be an RFC 3339 UTC timestamp`);
  }
  const at = parseLogTimestamp(value);
  if (at === null) throw new RangeError(`${field} must be an RFC 3339 UTC timestamp`);
  return { text: value, at };
}

export function metricsHostSample(input: { readonly deltaSeconds?: number } = {}): RemoteCommand {
  const delta = boundedInteger(input.deltaSeconds ?? 1, 1, HOST_SAMPLE_MAX_DELTA_SECONDS, "deltaSeconds");
  return script("metrics.host_sample", METRICS_SCRIPTS.hostSample, OBSERVABILITY_LIMITS.hostSample, [
    String(delta),
  ]);
}

/** `docker.stats`: inspect state (`I `) and stats (`S `) lines, parsed by parseContainerSample. */
export function dockerStatsSample(input: { readonly serviceId?: ResourceId } = {}): RemoteCommand {
  return script("docker.stats", METRICS_SCRIPTS.containerSample, OBSERVABILITY_LIMITS.containerSample, [
    INSPECT_STATE_TEMPLATE,
    STATS_TEMPLATE,
    serviceFilter(input.serviceId),
  ]);
}

/** `docker.inspect_state`: inspect state lines only (`I `), parsed by parseContainerSample. */
export function dockerInspectStateSample(input: { readonly serviceId?: ResourceId } = {}): RemoteCommand {
  return script("docker.inspect_state", METRICS_SCRIPTS.inspectState, OBSERVABILITY_LIMITS.inspectState, [
    INSPECT_STATE_TEMPLATE,
    serviceFilter(input.serviceId),
  ]);
}

export interface LogsWindowInput {
  readonly serviceId: ResourceId;
  /** Inclusive lower bound, RFC 3339 UTC. */
  readonly since: string;
  /** Inclusive upper bound, RFC 3339 UTC; applied by parseLogsWindow, never sent to Docker. */
  readonly until?: string;
  /** Last N lines at or after `since`, 1..MAX_LOG_TAIL. */
  readonly tail: number;
}

/** H1: every input is validated before any argv or command string exists. */
export function dockerLogsWindow(input: LogsWindowInput): RemoteCommand {
  const container = containerNameFor(input.serviceId);
  if (!container.ok) throw new RangeError("serviceId must be a resource id");
  const since = utcTimestamp(input.since, "since");
  if (input.until !== undefined) {
    const until = utcTimestamp(input.until, "until");
    if (compareLogTimestamps(until.at, since.at) <= 0) throw new RangeError("until must be after since");
  }
  const tail = boundedInteger(input.tail, 1, MAX_LOG_TAIL, "tail");
  return script("docker.logs_window", METRICS_SCRIPTS.logsWindow, OBSERVABILITY_LIMITS.logsWindow, [
    container.value,
    since.text,
    String(tail),
  ]);
}

export interface LogsWindowLine {
  readonly timestamp: string;
  readonly stream: "stdout" | "stderr";
  readonly text: string;
  /** The line was longer than LOGS_WINDOW_MAX_LINE_LENGTH and was cut. */
  readonly truncated: boolean;
}

export type LogsWindow =
  | { readonly kind: "missing" }
  | {
      readonly kind: "ok";
      /** Ordered by timestamp; equal timestamps keep Docker's order. */
      readonly lines: readonly LogsWindowLine[];
      /** The output hit the `head -c` cap: the window holds fewer lines than asked for. */
      readonly capped: boolean;
      /** Lines that could not be read (cut by the cap, no stream prefix, no timestamp). */
      readonly dropped: number;
    };

const MISSING_MARKER = "NOODARA_LOGS missing";
/** `head -c` closed the pipe: 128 + SIGPIPE. */
const SIGPIPE_EXIT = 141;

function cutText(text: string): { text: string; truncated: boolean } {
  if (text.length <= LOGS_WINDOW_MAX_LINE_LENGTH) return { text, truncated: false };
  let cut = text.slice(0, LOGS_WINDOW_MAX_LINE_LENGTH);
  const last = cut.charCodeAt(cut.length - 1);
  // Never end on half a surrogate pair.
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return { text: cut, truncated: true };
}

/**
 * Reads a docker.logs_window output. A line cut by the output cap (no trailing newline) is dropped
 * and flagged through `capped`; it never fails the whole window. Lines after `until` are filtered.
 */
export function parseLogsWindow(
  stdout: string,
  options: { readonly until?: string; readonly exitCode?: number | null } = {},
): LogsWindow {
  const until = options.until === undefined ? null : utcTimestamp(options.until, "until").at;
  const raw = stdout.split("\n");
  // The segment after the last newline is empty for a complete output; otherwise it was cut.
  const tailSegment = raw.pop() ?? "";
  if (raw[0] === MISSING_MARKER && tailSegment === "" && raw.length === 1) return { kind: "missing" };
  const cutLine = tailSegment !== "";
  const capped = cutLine || options.exitCode === SIGPIPE_EXIT;
  let dropped = cutLine ? 1 : 0;

  const lines: { line: LogsWindowLine; at: LogTimestamp }[] = [];
  for (const entry of raw) {
    const stream = entry.startsWith("O ") ? "stdout" : entry.startsWith("E ") ? "stderr" : null;
    const body = entry.slice(2);
    const space = body.indexOf(" ");
    const timestamp = space < 0 ? body : body.slice(0, space);
    const at = stream === null ? null : parseLogTimestamp(timestamp);
    if (stream === null || at === null) {
      dropped += 1;
      continue;
    }
    if (until !== null && compareLogTimestamps(at, until) > 0) continue;
    const { text, truncated } = cutText(space < 0 ? "" : body.slice(space + 1));
    lines.push({ line: { timestamp, stream, text, truncated }, at });
  }
  lines.sort((a, b) => compareLogTimestamps(a.at, b.at));
  return { kind: "ok", lines: lines.map((entry) => entry.line), capped, dropped };
}
