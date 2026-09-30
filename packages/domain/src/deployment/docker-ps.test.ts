import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDockerPsOutput, toContainerObservation } from "./docker-ps.js";

const VERSIONS = ["22.04", "24.04"] as const;

function ps(version: string): string {
  return readFileSync(
    new URL(`./fixtures/ubuntu-${version}/docker_ps.ndjson`, import.meta.url),
    "utf8",
  );
}

function ok(stdout: string) {
  const result = parseDockerPsOutput({ stdout, stderr: "", exitCode: 0 });
  if (result.kind !== "ok") {
    throw new Error(`expected ok, got ${result.kind}`);
  }
  return result;
}

describe("parseDockerPsOutput (real captures)", () => {
  it.each(VERSIONS)("parses the three containers of Ubuntu %s", (version) => {
    const result = ok(ps(version));
    expect(result.unparseableLines).toEqual([]);
    expect(result.containers.map((c) => c.state).sort()).toEqual([
      "created",
      "exited",
      "running",
    ]);
    const exited = result.containers.find((c) => c.state === "exited");
    expect(exited?.exitCode).toBe(3);
    const running = result.containers.find((c) => c.state === "running");
    expect(running?.exitCode).toBeNull();
    expect(running?.ports).toContain("->");
    for (const c of result.containers) {
      expect(c.labels["noodara.managed"]).toBe("true");
      expect(c.labels["noodara.service_id"]).toMatch(/^[0-9a-f-]{36}$/);
      expect(c.name).toMatch(/^noodara-/);
    }
  });

  it.each(VERSIONS)("maps observations by name on Ubuntu %s", (version) => {
    const { containers } = ok(ps(version));
    const byState = (s: string) =>
      containers.find((c) => c.state === s)?.name ?? "";
    expect(toContainerObservation(containers, byState("running"))).toEqual({
      kind: "running",
    });
    expect(toContainerObservation(containers, byState("exited"))).toEqual({
      kind: "stopped",
      exitCode: 3,
    });
    expect(toContainerObservation(containers, byState("created"))).toEqual({
      kind: "stopped",
      exitCode: null,
    });
    expect(toContainerObservation(containers, "noodara-nope")).toEqual({
      kind: "absent",
    });
  });
});

describe("parseDockerPsOutput (edge cases)", () => {
  const line = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      ID: "a",
      Image: "i",
      Names: "n1",
      State: "running",
      Status: "Up 1 second",
      Labels: "a=b=c,x=y",
      Ports: "",
      ...over,
    });

  it("isolates a corrupted line and keeps the rest", () => {
    const result = ok(`${line()}\n{not json\n${line({ Names: "n2" })}\n`);
    expect(result.containers).toHaveLength(2);
    expect(result.unparseableLines).toHaveLength(1);
    expect(result.unparseableLines[0]?.line).toBe(2);
  });

  it("keeps label values containing = intact and handles empty labels", () => {
    const result = ok(`${line()}\n${line({ Names: "n2", Labels: "" })}\n`);
    expect(result.containers[0]?.labels).toEqual({ a: "b=c", x: "y" });
    expect(result.containers[1]?.labels).toEqual({});
  });

  it("skips label entries without =", () => {
    expect(ok(line({ Labels: "novalue,k=v" })).containers[0]?.labels).toEqual({
      k: "v",
    });
  });

  it("rejects lines missing Names or State, or with unknown state", () => {
    const result = ok(
      [
        line({ Names: undefined }),
        line({ State: undefined }),
        line({ State: "bogus" }),
        line({ Names: "" }),
        "[]",
        "null",
        '"s"',
      ].join("\n"),
    );
    expect(result.containers).toEqual([]);
    expect(result.unparseableLines.map((l) => l.line)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
  });

  it("tolerates missing optional fields and non-string ones", () => {
    const result = ok(
      JSON.stringify({
        Names: "n",
        State: "exited",
        Status: "Exited (x) ago",
        Labels: 5,
        Image: 1,
        ID: null,
      }),
    );
    expect(result.containers[0]).toMatchObject({
      name: "n",
      exitCode: null,
      labels: {},
      ports: "",
      image: "",
      id: "",
    });
  });

  it("ignores blank lines and tolerates CRLF", () => {
    const result = ok(`${line()}\r\n\r\n\n${line({ Names: "n2" })}\r\n`);
    expect(result.containers).toHaveLength(2);
    expect(result.unparseableLines).toEqual([]);
  });

  it("empty stdout with exit 0 is ok with zero containers", () => {
    expect(ok("")).toEqual({
      kind: "ok",
      containers: [],
      unparseableLines: [],
    });
  });

  it("exit 127 is unparseable, never daemon_unreachable", () => {
    expect(
      parseDockerPsOutput({ stdout: "", stderr: "", exitCode: 127 }).kind,
    ).toBe("unparseable");
  });

  it("detects an unreachable daemon", () => {
    const r = parseDockerPsOutput({
      stdout: "",
      stderr:
        "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
      exitCode: 1,
    });
    expect(r).toEqual({ kind: "daemon_unreachable" });
  });

  it("non-zero exit with other stderr is unparseable", () => {
    const r = parseDockerPsOutput({ stdout: "", stderr: "boom", exitCode: 1 });
    expect(r.kind).toBe("unparseable");
  });

  it("reports observations for paused, restarting, removing and dead", () => {
    const mk = (state: string) =>
      ok(line({ Names: "x", State: state, Status: "whatever" })).containers;
    expect(toContainerObservation(mk("paused"), "x")).toEqual({
      kind: "unknown",
    });
    expect(toContainerObservation(mk("restarting"), "x")).toEqual({
      kind: "unknown",
    });
    expect(toContainerObservation(mk("removing"), "x")).toEqual({
      kind: "unknown",
    });
    expect(toContainerObservation(mk("dead"), "x")).toEqual({
      kind: "stopped",
      exitCode: null,
    });
  });
});
