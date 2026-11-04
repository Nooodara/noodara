import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseContainerSample, parseHostSample, type ResourceId } from "@noodara/domain";
import { ADVERSARIAL_VALUES, shellWords } from "../testing/shell-round-trip.js";
import { createRemoteCommand, renderRemoteCommand, type RemoteCommand } from "./remote-command.js";
import {
  INSPECT_STATE_TEMPLATE,
  LOGS_WINDOW_MAX_LINE_LENGTH,
  MAX_LOG_TAIL,
  METRICS_SCRIPTS,
  OBSERVABILITY_LIMITS,
  STATS_TEMPLATE,
  dockerInspectStateSample,
  dockerLogsWindow,
  dockerStatsSample,
  metricsHostSample,
  parseLogsWindow,
} from "./metrics.js";

vi.mock("./remote-command.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./remote-command.js")>();
  return { ...actual, createRemoteCommand: vi.fn(actual.createRemoteCommand) };
});

const SERVICE_ID = "3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e" as ResourceId;
const SINCE = "2026-11-04T10:00:00Z";
const createSpy = vi.mocked(createRemoteCommand);

/** The `bash -c` body of a bounded template and its positional arguments. */
function bodyOf(command: RemoteCommand): { body: string; args: string[] } {
  const index = command.argv.indexOf("-c");
  return { body: command.argv[index + 1] ?? "", args: command.argv.slice(index + 3) };
}

function expectBounded(command: RemoteCommand, seconds: number, cap: number): void {
  expect(command.argv.slice(0, 12)).toEqual([
    "env",
    "-i",
    "PATH=/usr/sbin:/usr/bin:/sbin:/bin",
    "LC_ALL=C",
    "timeout",
    "-k",
    "1",
    String(seconds),
    "bash",
    "--noprofile",
    "--norc",
    "-c",
  ]);
  expect(command.argv[12]).toMatch(/^set -o pipefail\n\{\n/);
  expect(command.argv[12]?.endsWith(`\n} 2>&1 | head -c ${String(cap)}`)).toBe(true);
  expect(command.argv[13]).toBe("noodara-metrics");
  expect(command.argv.some((token) => token.startsWith("HOME="))).toBe(false);
  expect(command.stdin).toBe("none");
  expect(command.supervisable).toBe(false);
  expect(Object.isFrozen(command.argv)).toBe(true);
}

beforeEach(() => {
  createSpy.mockClear();
});

describe("metrics.host_sample (A1)", () => {
  it("runs the ADR 0012 host script bounded, with the delta as its only argument", () => {
    const command = metricsHostSample({ deltaSeconds: 2 });

    expect(command.name).toBe("metrics.host_sample");
    expectBounded(command, 15, OBSERVABILITY_LIMITS.hostSample.capBytes);
    expect(bodyOf(command)).toEqual({
      body: `set -o pipefail\n{\n${METRICS_SCRIPTS.hostSample}\n} 2>&1 | head -c 65536`,
      args: ["2"],
    });
    expect(bodyOf(metricsHostSample()).args).toEqual(["1"]);
  });

  it.each([0, -1, 6, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1e9])(
    "rejects deltaSeconds %s before building a command",
    (deltaSeconds) => {
      expect(() => metricsHostSample({ deltaSeconds })).toThrow(RangeError);
      expect(createSpy).not.toHaveBeenCalled();
    },
  );

  it("its output on a real shell parses with parseHostSample", () => {
    const fake = fakeBin({
      docker: 'echo /var/lib/docker',
      head: 'if [ "$1" = -n1 ]; then echo "cpu  100 0 100 700 100 0 0 0 0 0"; else exec /usr/bin/head "$@"; fi',
      sleep: "true",
      df: 'printf "Mounted on 1B 2B 3B\\n/ 100 40 60\\n/var/lib/docker 100 40 60\\n"',
      grep: 'printf "MemTotal: 2048 kB\\nMemAvailable: 1024 kB\\n"',
      cat: 'echo "12.5 40.0"',
    });
    const result = runBody(metricsHostSample(), fake);
    expect(result.status).toBe(0);
    expect(parseHostSample(result.stdout).ok).toBe(true);
  });
});

describe("docker.stats and docker.inspect_state (A1)", () => {
  it("docker.stats passes the inspect and stats templates and the managed filter as arguments", () => {
    const command = dockerStatsSample();

    expect(command.name).toBe("docker.stats");
    expectBounded(command, 30, OBSERVABILITY_LIMITS.containerSample.capBytes);
    expect(bodyOf(command).args).toEqual([INSPECT_STATE_TEMPLATE, STATS_TEMPLATE, "label=noodara.managed=true"]);
  });

  it("filters by the service label when a service id is given", () => {
    expect(bodyOf(dockerStatsSample({ serviceId: SERVICE_ID })).args[2]).toBe(
      `label=noodara.service_id=${SERVICE_ID}`,
    );
    const inspect = dockerInspectStateSample({ serviceId: SERVICE_ID });
    expect(inspect.name).toBe("docker.inspect_state");
    expectBounded(inspect, 20, OBSERVABILITY_LIMITS.inspectState.capBytes);
    expect(bodyOf(inspect).args).toEqual([INSPECT_STATE_TEMPLATE, `label=noodara.service_id=${SERVICE_ID}`]);
  });

  it.each(ADVERSARIAL_VALUES)("rejects service id %j before building a command", (value) => {
    expect(() => dockerStatsSample({ serviceId: value as ResourceId })).toThrow(RangeError);
    expect(() => dockerInspectStateSample({ serviceId: value as ResourceId })).toThrow(RangeError);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("the inspect template never selects env, cmd, mounts or the health output", () => {
    for (const forbidden of [/\.Config\b/, /\.Mounts\b/, /Output/, /\{\{\s*json\s+\.\s*\}\}/]) {
      expect(INSPECT_STATE_TEMPLATE).not.toMatch(forbidden);
    }
  });

  it("a failed docker ps exits 3; an inspect race keeps the exit 0 and the parseable lines", () => {
    const down = fakeBin({ docker: 'echo "Cannot connect to the Docker daemon" >&2; exit 1' });
    expect(runBody(dockerStatsSample(), down).status).toBe(3);
    expect(runBody(dockerInspectStateSample(), down).status).toBe(3);

    const row =
      '{"id":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","name":"/noodara-x","status":"running","running":true,"restarting":false,' +
      '"restartCount":0,"oomKilled":false,"exitCode":0,"startedAt":"2026-11-04T10:00:00.1Z",' +
      '"finishedAt":"0001-01-01T00:00:00Z","health":null,"healthExitCodes":[],"memoryLimit":0}';
    const racing = fakeBin({
      docker: [
        'case "$1" in',
        "  ps) echo 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef;;",
        `  inspect) printf '%s\\n' '${row}'; echo "Error: No such object: gone" >&2; exit 1;;`,
        '  stats) printf "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\\t1.50%%\\t10MiB / 1GiB\\n";;',
        "esac",
      ].join("\n"),
    });
    const result = runBody(dockerStatsSample(), racing);
    expect(result.status).toBe(0);
    const parsed = parseContainerSample(result.stdout);
    expect(parsed.ok && parsed.value.map((sample) => sample.id)).toEqual(["0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"]);
  });
});

describe("docker.logs_window (A1, H1)", () => {
  it("passes the container name, since and tail; never --until", () => {
    const command = dockerLogsWindow({
      serviceId: SERVICE_ID,
      since: SINCE,
      until: "2026-11-04T10:05:00.123456789Z",
      tail: 200,
    });

    expect(command.name).toBe("docker.logs_window");
    expectBounded(command, 20, OBSERVABILITY_LIMITS.logsWindow.capBytes);
    expect(bodyOf(command).args).toEqual([`noodara-${SERVICE_ID}`, SINCE, "200"]);
    expect(command.argv.join(" ")).not.toContain("--until");
    expect(shellWords(renderRemoteCommand(command))).toEqual(command.argv);
  });

  const valid = { serviceId: SERVICE_ID, since: SINCE, tail: 10 };
  const invalidTimestamps = [
    ...ADVERSARIAL_VALUES,
    "2026-11-04T10:00:00",
    "2026-11-04T10:00:00+00:00",
    "2026-11-04 10:00:00Z",
    "2026-02-30T10:00:00Z",
    "2026-11-04T24:00:00Z",
    "2026-11-04T10:00:00.1234567890Z",
    `${SINCE}; reboot`,
    `${SINCE}\n`,
    "-1",
    "",
  ];

  it.each(invalidTimestamps)("rejects since %j before building a command", (since) => {
    expect(() => dockerLogsWindow({ ...valid, since })).toThrow(RangeError);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it.each(invalidTimestamps)("rejects until %j before building a command", (until) => {
    expect(() => dockerLogsWindow({ ...valid, until })).toThrow(RangeError);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("rejects an until that is not after since", () => {
    expect(() => dockerLogsWindow({ ...valid, until: SINCE })).toThrow(RangeError);
    expect(() => dockerLogsWindow({ ...valid, until: "2026-11-04T09:59:59.999Z" })).toThrow(RangeError);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it.each([0, -1, -1000, MAX_LOG_TAIL + 1, 1e9, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects tail %s before building a command",
    (tail) => {
      expect(() => dockerLogsWindow({ ...valid, tail })).toThrow(RangeError);
      expect(createSpy).not.toHaveBeenCalled();
    },
  );

  it.each([...ADVERSARIAL_VALUES, "10", "1e3"])("rejects a non-number tail %j", (tail) => {
    expect(() => dockerLogsWindow({ ...valid, tail: tail as unknown as number })).toThrow(RangeError);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it.each(ADVERSARIAL_VALUES)("rejects service id %j before building a command", (value) => {
    expect(() => dockerLogsWindow({ ...valid, serviceId: value as ResourceId })).toThrow(RangeError);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("accepts the bounds of tail", () => {
    expect(bodyOf(dockerLogsWindow({ ...valid, tail: 1 })).args[2]).toBe("1");
    expect(bodyOf(dockerLogsWindow({ ...valid, tail: MAX_LOG_TAIL })).args[2]).toBe(String(MAX_LOG_TAIL));
  });

  it("on a real shell prefixes stdout with O and stderr with E", () => {
    const fake = fakeBin({
      docker: [
        'case "$1" in',
        "  container) echo sha256abc;;",
        '  logs) echo "2026-11-04T10:00:01.000000001Z out"; echo "2026-11-04T10:00:02.000000000Z err" >&2;;',
        "esac",
      ].join("\n"),
    });
    const result = runBody(dockerLogsWindow(valid), fake);
    expect(result.status).toBe(0);
    expect(result.stdout.split("\n").sort()).toEqual([
      "",
      "E 2026-11-04T10:00:02.000000000Z err",
      "O 2026-11-04T10:00:01.000000001Z out",
    ]);
  });

  it("on a real shell reports a missing container with the marker, other inspect failures with exit 3", () => {
    const missing = fakeBin({ docker: 'echo "Error: No such container: noodara-x" >&2; exit 1' });
    const result = runBody(dockerLogsWindow(valid), missing);
    expect(result.status).toBe(0);
    expect(parseLogsWindow(result.stdout, { exitCode: result.status })).toEqual({ kind: "missing" });

    const down = fakeBin({ docker: 'echo "Cannot connect to the Docker daemon" >&2; exit 1' });
    expect(runBody(dockerLogsWindow(valid), down).status).toBe(3);
  });

  it("every script parses as bash", () => {
    for (const body of Object.values(METRICS_SCRIPTS)) {
      expect(spawnSync("bash", ["-n", "-c", body]).status).toBe(0);
    }
  });
});

describe("parseLogsWindow (H1)", () => {
  const TS1 = "2026-11-04T10:00:01.000000000Z";
  const TS2 = "2026-11-04T10:00:02.000000000Z";
  const TS3 = "2026-11-04T10:00:03.000000000Z";

  it("reads both streams and orders them by timestamp, stable on ties", () => {
    const stdout = [`O ${TS2} b`, `O ${TS2} c`, `E ${TS1} a`, `O ${TS3}`, ""].join("\n");

    expect(parseLogsWindow(stdout, { exitCode: 0 })).toEqual({
      kind: "ok",
      lines: [
        { timestamp: TS1, stream: "stderr", text: "a", truncated: false },
        { timestamp: TS2, stream: "stdout", text: "b", truncated: false },
        { timestamp: TS2, stream: "stdout", text: "c", truncated: false },
        { timestamp: TS3, stream: "stdout", text: "", truncated: false },
      ],
      capped: false,
      dropped: 0,
    });
  });

  it("an empty output is an empty window", () => {
    expect(parseLogsWindow("")).toEqual({ kind: "ok", lines: [], capped: false, dropped: 0 });
  });

  it("filters lines after until (inclusive bound)", () => {
    const stdout = [`O ${TS1} a`, `O ${TS2} b`, `O ${TS3} c`, ""].join("\n");
    const window = parseLogsWindow(stdout, { until: TS2 });
    expect(window.kind === "ok" && window.lines.map((line) => line.text)).toEqual(["a", "b"]);
  });

  it("rejects an invalid until", () => {
    expect(() => parseLogsWindow("", { until: "yesterday" })).toThrow(RangeError);
  });

  it("drops and flags a line cut by the output cap instead of failing the window", () => {
    const stdout = `O ${TS1} a\nO ${TS2} b\nO 2026-11-04T10:0`;
    expect(parseLogsWindow(stdout, { exitCode: 141 })).toEqual({
      kind: "ok",
      lines: [
        { timestamp: TS1, stream: "stdout", text: "a", truncated: false },
        { timestamp: TS2, stream: "stdout", text: "b", truncated: false },
      ],
      capped: true,
      dropped: 1,
    });
  });

  it("flags a SIGPIPE exit as capped even when the cut fell on a newline", () => {
    const window = parseLogsWindow(`O ${TS1} a\n`, { exitCode: 141 });
    expect(window).toMatchObject({ kind: "ok", capped: true, dropped: 0 });
  });

  it("counts unprefixed and timestamp-less lines as dropped", () => {
    const stdout = ["Error response from daemon: boom", "E not-a-timestamp text", "X weird", `O ${TS1} a`, ""].join(
      "\n",
    );
    expect(parseLogsWindow(stdout)).toMatchObject({ kind: "ok", dropped: 3, capped: false });
  });

  it("cuts and flags a line longer than the line limit", () => {
    const long = "x".repeat(LOGS_WINDOW_MAX_LINE_LENGTH + 10);
    const window = parseLogsWindow(`O ${TS1} ${long}\n`);
    expect(window.kind === "ok" && window.lines[0]).toEqual({
      timestamp: TS1,
      stream: "stdout",
      text: "x".repeat(LOGS_WINDOW_MAX_LINE_LENGTH),
      truncated: true,
    });
  });

  it("never ends a cut line on half a surrogate pair", () => {
    const long = `${"x".repeat(LOGS_WINDOW_MAX_LINE_LENGTH - 1)}\u{1F600}tail`;
    const window = parseLogsWindow(`O ${TS1} ${long}\n`);
    const text = window.kind === "ok" ? (window.lines[0]?.text ?? "") : "";
    expect(text).toBe("x".repeat(LOGS_WINDOW_MAX_LINE_LENGTH - 1));
  });

  it("the missing marker is only recognised as the whole output", () => {
    expect(parseLogsWindow("NOODARA_LOGS missing\n")).toEqual({ kind: "missing" });
    expect(parseLogsWindow(`NOODARA_LOGS missing\nO ${TS1} a\n`)).toMatchObject({ kind: "ok", dropped: 1 });
  });
});

// --- Local shell harness: the template body under bash with fake binaries on PATH ------------------

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function fakeBin(scripts: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "noodara-metrics-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(scripts)) {
    const file = join(dir, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
  }
  return dir;
}

function runBody(command: RemoteCommand, bin: string): { status: number | null; stdout: string } {
  const { body, args } = bodyOf(command);
  const result = spawnSync("bash", ["--noprofile", "--norc", "-c", body, "noodara-metrics", ...args], {
    encoding: "utf8",
    env: { PATH: `${bin}:/usr/bin:/bin`, LC_ALL: "C" },
    timeout: 10_000,
  });
  return { status: result.status, stdout: result.stdout };
}
