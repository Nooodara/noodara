import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseContainerState } from "./container-state.js";

function capture(version: string, state: string): string {
  return readFileSync(
    new URL(
      `./fixtures/ubuntu-${version}/docker_inspect_state_${state}.json`,
      import.meta.url,
    ),
    "utf8",
  );
}

describe("parseContainerState (real captures)", () => {
  it.each(["22.04", "24.04"])(
    "parses running and exited on Ubuntu %s",
    (version) => {
      const running = parseContainerState(capture(version, "running"));
      expect(running).toMatchObject({
        kind: "ok",
        status: "running",
        running: true,
        oomKilled: false,
      });
      const exited = parseContainerState(capture(version, "exited"));
      expect(exited).toMatchObject({
        kind: "ok",
        status: "exited",
        running: false,
        exitCode: 3,
      });
      if (running.kind === "ok") {
        expect(running.finishedAt).toBe("0001-01-01T00:00:00Z");
        expect(running.startedAt).toMatch(/^\d{4}-/);
      }
    },
  );
});

describe("parseContainerState (edge cases)", () => {
  const valid = {
    Status: "exited",
    Running: false,
    ExitCode: 1,
    OOMKilled: true,
    StartedAt: "s",
    FinishedAt: "f",
  };

  it("accepts a trailing newline and reports oomKilled", () => {
    expect(parseContainerState(`${JSON.stringify(valid)}\n`)).toEqual({
      kind: "ok",
      status: "exited",
      running: false,
      exitCode: 1,
      oomKilled: true,
      startedAt: "s",
      finishedAt: "f",
    });
  });

  it.each([
    ["{}"],
    ["not json"],
    [""],
    ["[]"],
    ["null"],
    [JSON.stringify({ ...valid, Status: "weird" })],
    [JSON.stringify({ ...valid, Running: "no" })],
    [JSON.stringify({ ...valid, ExitCode: "1" })],
    [JSON.stringify({ ...valid, OOMKilled: 0 })],
    [JSON.stringify({ ...valid, StartedAt: 1 })],
    [JSON.stringify({ ...valid, FinishedAt: null })],
  ])("rejects %s", (input) => {
    expect(parseContainerState(input).kind).toBe("unparseable");
  });
});
