import { describe, expect, it } from "vitest";
import {
  createBuildLogChunker,
  createLogChunkerPolicy,
  DEFAULT_LOG_CHUNKER_POLICY,
  LOG_LINE_TRUNCATED_MARKER,
  type BuildLogChunk,
  type LogChunkerPolicy,
} from "./log-chunker.js";

const encoder = new TextEncoder();
const byteLength = (text: string): number => encoder.encode(text).length;

function fakeClock(start = 0): {
  now: () => number;
  advance: (ms: number) => void;
  set: (ms: number) => void;
} {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
    set: (ms) => {
      current = ms;
    },
  };
}

function setup(policy: Partial<LogChunkerPolicy> = {}) {
  const clock = fakeClock();
  const chunker = createBuildLogChunker({
    deploymentId: "dep_1",
    now: clock.now,
    policy: { ...DEFAULT_LOG_CHUNKER_POLICY, ...policy },
  });
  return { clock, chunker };
}

const outputText = (chunks: readonly BuildLogChunk[]): string =>
  chunks
    .filter((chunk) => chunk.kind === "output")
    .map((chunk) => chunk.text)
    .join("");

const SMALL = {
  flushBytes: 1024,
  maxLineBytes: 1024,
  maxPhaseBytes: 4096,
} as const;

describe("DEFAULT_LOG_CHUNKER_POLICY", () => {
  it("flushes every 250 ms or 16 KB, caps lines at 16 KB and phases at 10 MiB", () => {
    expect(DEFAULT_LOG_CHUNKER_POLICY).toEqual({
      flushIntervalMs: 250,
      flushBytes: 16_384,
      maxLineBytes: 16_384,
      maxPhaseBytes: 10 * 1024 * 1024,
    });
    expect(Object.isFrozen(DEFAULT_LOG_CHUNKER_POLICY)).toBe(true);
  });
});

describe("createLogChunkerPolicy", () => {
  it("accepts the defaults", () => {
    expect(createLogChunkerPolicy(DEFAULT_LOG_CHUNKER_POLICY)).toEqual({
      ok: true,
      value: DEFAULT_LOG_CHUNKER_POLICY,
    });
  });

  it.each([
    ["interval below 50 ms", { flushIntervalMs: 49 }],
    ["interval above 5000 ms", { flushIntervalMs: 5001 }],
    ["fractional interval", { flushIntervalMs: 250.5 }],
    ["flush size below 1 KiB", { flushBytes: 1023 }],
    ["flush size above the line cap", { flushBytes: 16_385 }],
    ["line cap below 1 KiB", { maxLineBytes: 1023, flushBytes: 1023 }],
    ["line cap above 1 MiB", { maxLineBytes: 1_048_577 }],
    ["phase cap below the line cap", { maxPhaseBytes: 16_383 }],
    ["phase cap above 100 MiB", { maxPhaseBytes: 104_857_601 }],
    ["NaN", { flushBytes: Number.NaN }],
  ])("rejects %s", (_label, override) => {
    const result = createLogChunkerPolicy({
      ...DEFAULT_LOG_CHUNKER_POLICY,
      ...override,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("LOG_CHUNKER_POLICY_INVALID");
  });
});

describe("createBuildLogChunker", () => {
  it("uses the default policy when none is given", () => {
    const clock = fakeClock();
    const chunker = createBuildLogChunker({
      deploymentId: "dep_1",
      now: clock.now,
    });

    expect(chunker.push("build", "x".repeat(16_383) + "\n")).toHaveLength(1);
  });

  it("throws RangeError on an empty deploymentId", () => {
    expect(() =>
      createBuildLogChunker({ deploymentId: "", now: () => 0 }),
    ).toThrow(RangeError);
  });

  it("throws RangeError on an invalid policy", () => {
    expect(() =>
      createBuildLogChunker({
        deploymentId: "dep_1",
        now: () => 0,
        policy: { ...DEFAULT_LOG_CHUNKER_POLICY, flushIntervalMs: 0 },
      }),
    ).toThrow(RangeError);
  });

  it("throws RangeError on an unknown phase", () => {
    const { chunker } = setup();

    expect(() => chunker.push("runtime" as never, "x\n")).toThrow(RangeError);
    expect(() => chunker.flush("runtime" as never)).toThrow(RangeError);
  });
});

describe("time-based flush", () => {
  it("holds output until the interval elapses on the injected clock", () => {
    const { clock, chunker } = setup();

    expect(chunker.push("build", "Step 1/3\n")).toEqual([]);
    clock.advance(249);
    expect(chunker.tick()).toEqual([]);
    clock.advance(1);
    const chunks = chunker.tick();

    expect(chunks).toEqual([
      {
        deploymentId: "dep_1",
        phase: "build",
        seq: 1,
        kind: "output",
        text: "Step 1/3\n",
        byteLength: 9,
        truncated: false,
      },
    ]);
    expect(chunker.tick()).toEqual([]);
  });

  it("flushes overdue output on the next push without waiting for a tick", () => {
    const { clock, chunker } = setup();

    chunker.push("build", "a\n");
    clock.advance(300);
    const chunks = chunker.push("build", "b\n");

    expect(chunks.map((chunk) => chunk.text)).toEqual(["a\nb\n"]);
  });

  it("measures the interval from the first pending byte, not the latest", () => {
    const { clock, chunker } = setup();

    chunker.push("build", "a\n");
    clock.advance(200);
    chunker.push("build", "b\n");
    clock.advance(50);

    expect(chunker.tick().map((chunk) => chunk.text)).toEqual(["a\nb\n"]);
  });

  it("flushes a partial line on time so a slow step is still visible", () => {
    const { clock, chunker } = setup();

    chunker.push("build", "Downloading");
    clock.advance(250);
    const first = chunker.tick();
    chunker.push("build", " done\n");
    clock.advance(250);
    const second = chunker.tick();

    expect(first.map((chunk) => chunk.text)).toEqual(["Downloading"]);
    expect(second.map((chunk) => chunk.text)).toEqual([" done\n"]);
  });

  it("reports how long until the next flush is due", () => {
    const { clock, chunker } = setup();

    expect(chunker.msUntilNextFlush()).toBeNull();
    chunker.push("build", "a\n");
    expect(chunker.msUntilNextFlush()).toBe(250);
    clock.advance(100);
    expect(chunker.msUntilNextFlush()).toBe(150);
    clock.advance(500);
    expect(chunker.msUntilNextFlush()).toBe(0);
    chunker.tick();
    expect(chunker.msUntilNextFlush()).toBeNull();
  });

  it("reports the earliest due phase across phases", () => {
    const { clock, chunker } = setup();

    chunker.push("prepare", "p\n");
    clock.advance(100);
    chunker.push("build", "b\n");

    expect(chunker.msUntilNextFlush()).toBe(150);
  });

  it("restarts the interval when the clock moves backwards instead of stalling", () => {
    const { clock, chunker } = setup();
    clock.set(10_000);
    chunker.push("build", "a\n");

    clock.set(5_000);

    expect(chunker.msUntilNextFlush()).toBe(250);
    expect(chunker.tick()).toEqual([]);
    clock.advance(250);
    expect(chunker.tick().map((chunk) => chunk.text)).toEqual(["a\n"]);
  });
});

describe("size-based flush", () => {
  it("flushes as soon as the default 16 KB is buffered", () => {
    const { chunker } = setup();
    const line = "x".repeat(1023) + "\n";

    const chunks = chunker.push("build", line.repeat(16));

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.byteLength).toBe(16_384);
    expect(chunker.msUntilNextFlush()).toBeNull();
  });

  it("never lets a chunk grow past the flush size when lines are smaller", () => {
    const { chunker } = setup({ flushBytes: 1024 });
    const line = "y".repeat(299) + "\n";

    const chunks = chunker.push("build", line.repeat(10));

    expect(chunks.map((chunk) => chunk.byteLength)).toEqual([900, 900, 900]);
    expect(chunker.flush("build").map((chunk) => chunk.byteLength)).toEqual([
      300,
    ]);
  });

  it("reports byteLength in UTF-8 bytes, not UTF-16 units", () => {
    const { chunker } = setup();

    const [chunk] = chunker.push("build", "€🚀\n").concat(chunker.flush());

    expect(chunk?.byteLength).toBe(byteLength("€🚀\n"));
  });
});

describe("sequence numbers", () => {
  it("starts at 1 and increases by one per chunk within a phase", () => {
    const { chunker } = setup({ flushBytes: 1024 });

    const chunks = chunker.push("build", ("z".repeat(1023) + "\n").repeat(3));

    expect(chunks.map((chunk) => chunk.seq)).toEqual([1, 2, 3]);
  });

  it("keeps an independent sequence per phase, all tagged with the deployment", () => {
    const { chunker } = setup();

    chunker.push("prepare", "cloning\n");
    const prepare = chunker.flush("prepare");
    chunker.push("build", "one\n");
    const buildA = chunker.flush("build");
    chunker.push("build", "two\n");
    const buildB = chunker.flush("build");
    chunker.push("prepare", "again\n");
    const prepareB = chunker.flush("prepare");

    expect(prepare.map((chunk) => [chunk.phase, chunk.seq])).toEqual([
      ["prepare", 1],
    ]);
    expect(
      [...buildA, ...buildB].map((chunk) => [chunk.phase, chunk.seq]),
    ).toEqual([
      ["build", 1],
      ["build", 2],
    ]);
    expect(prepareB.map((chunk) => [chunk.phase, chunk.seq])).toEqual([
      ["prepare", 2],
    ]);
    expect(
      [...prepare, ...buildA, ...buildB, ...prepareB].every(
        (chunk) => chunk.deploymentId === "dep_1",
      ),
    ).toBe(true);
  });
});

describe("flush", () => {
  it("returns nothing when nothing is pending", () => {
    const { chunker } = setup();

    expect(chunker.flush()).toEqual([]);
    expect(chunker.flush("build")).toEqual([]);
  });

  it("ends a trailing partial line with a newline", () => {
    const { chunker } = setup();

    chunker.push("build", "no newline");

    expect(chunker.flush("build").map((chunk) => chunk.text)).toEqual([
      "no newline\n",
    ]);
  });

  it("flushes every phase in prepare, build, deploy order when no phase is given", () => {
    const { chunker } = setup();
    chunker.push("deploy", "d\n");
    chunker.push("prepare", "p\n");
    chunker.push("build", "b\n");

    const chunks = chunker.flush();

    expect(chunks.map((chunk) => chunk.phase)).toEqual([
      "prepare",
      "build",
      "deploy",
    ]);
  });

  it("only flushes the requested phase", () => {
    const { chunker } = setup();
    chunker.push("prepare", "p\n");
    chunker.push("build", "b\n");

    expect(chunker.flush("build").map((chunk) => chunk.phase)).toEqual([
      "build",
    ]);
    expect(chunker.msUntilNextFlush()).toBe(250);
  });

  it("starts a fresh line after a flush so the per-line cap still holds", () => {
    const { chunker } = setup(SMALL);
    chunker.push("build", "a".repeat(1000));
    chunker.flush("build");

    chunker.push("build", "b".repeat(1000) + "\n");
    const [chunk] = chunker.flush("build");

    expect(chunk?.text).toBe("b".repeat(1000) + "\n");
    expect(chunk?.truncated).toBe(false);
  });
});

describe("per-line cap", () => {
  const lineCap = DEFAULT_LOG_CHUNKER_POLICY.maxLineBytes;

  it("keeps a line of exactly the cap intact", () => {
    const { chunker } = setup();
    const line = "x".repeat(lineCap);

    const text = outputText([
      ...chunker.push("build", `${line}\n`),
      ...chunker.flush(),
    ]);

    expect(text).toBe(`${line}\n`);
  });

  it("cuts a longer line to the cap with a visible marker and keeps the next line", () => {
    const { chunker } = setup();

    const chunks = [
      ...chunker.push("build", `${"x".repeat(lineCap + 1)}\nnext\n`),
      ...chunker.flush(),
    ];
    const [first, second] = outputText(chunks).split("\n");

    expect(first?.endsWith(LOG_LINE_TRUNCATED_MARKER)).toBe(true);
    expect(byteLength(first ?? "")).toBe(lineCap);
    expect(second).toBe("next");
    expect(chunks.some((chunk) => chunk.truncated)).toBe(true);
  });

  it("cuts multi-byte text on a character boundary", () => {
    const { chunker } = setup();

    const chunks = [
      ...chunker.push("build", `${"€".repeat(6000)}\n`),
      ...chunker.flush(),
    ];
    const line = outputText(chunks).split("\n")[0] ?? "";
    const content = line.slice(0, -LOG_LINE_TRUNCATED_MARKER.length);

    expect(byteLength(line)).toBeLessThanOrEqual(lineCap);
    expect(content.length).toBeGreaterThan(0);
    expect(content.replaceAll("€", "")).toBe("");
  });

  it("never splits a surrogate pair", () => {
    const { chunker } = setup();

    const chunks = [
      ...chunker.push("build", `a${"🚀".repeat(5000)}\n`),
      ...chunker.flush(),
    ];
    const line = outputText(chunks).split("\n")[0] ?? "";

    expect(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
        line,
      ),
    ).toBe(false);
    expect(byteLength(line)).toBeLessThanOrEqual(lineCap);
  });

  it("counts a line streamed over many pushes and drops the rest after one marker", () => {
    const { clock, chunker } = setup(SMALL);
    const chunks: BuildLogChunk[] = [];

    for (let i = 0; i < 50; i += 1) {
      chunks.push(...chunker.push("build", "abcdefghij".repeat(10)));
      clock.advance(300);
      chunks.push(...chunker.tick());
    }
    chunks.push(...chunker.push("build", "tail\nafter\n"), ...chunker.flush());
    const lines = outputText(chunks).split("\n");

    expect(byteLength(lines[0] ?? "")).toBe(1024);
    expect(lines[0]?.endsWith(LOG_LINE_TRUNCATED_MARKER)).toBe(true);
    expect(outputText(chunks).split(LOG_LINE_TRUNCATED_MARKER)).toHaveLength(2);
    expect(lines[1]).toBe("after");
  });

  it("keeps a line that lands exactly on the cap across pushes intact", () => {
    const { chunker } = setup(SMALL);

    chunker.push("build", "q".repeat(1020));
    chunker.push("build", "q".repeat(4));
    const text = outputText([
      ...chunker.push("build", "\n"),
      ...chunker.flush(),
    ]);

    expect(text).toBe("q".repeat(1024) + "\n");
  });

  it("keeps an unterminated line between the marker budget and the cap intact on flush", () => {
    const { chunker } = setup(SMALL);

    chunker.push("build", "q".repeat(1022));

    expect(outputText(chunker.flush("build"))).toBe("q".repeat(1022) + "\n");
  });
});

describe("per-phase cap", () => {
  it("stops accepting at the cap and emits exactly one truncation notice", () => {
    const { chunker } = setup(SMALL);
    const line = "w".repeat(99) + "\n";
    const chunks: BuildLogChunk[] = [];

    for (let i = 0; i < 100; i += 1)
      chunks.push(...chunker.push("build", line));
    chunks.push(...chunker.flush());
    const notices = chunks.filter((chunk) => chunk.kind === "phase_truncated");

    expect(byteLength(outputText(chunks))).toBe(4096);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.truncated).toBe(true);
    expect(notices[0]?.text).toMatch(
      /^\n?\[noodara\] .*build.*4096 bytes.*\n$/,
    );
    expect(chunks.at(-1)).toBe(notices[0]);
    expect(chunks.map((chunk) => chunk.seq)).toEqual(
      chunks.map((_c, index) => index + 1),
    );
  });

  it("ignores later output, ticks and flushes for a capped phase", () => {
    const { clock, chunker } = setup(SMALL);
    chunker.push("build", ("v".repeat(99) + "\n").repeat(50));

    expect(chunker.push("build", "more\n")).toEqual([]);
    clock.advance(10_000);
    expect(chunker.tick()).toEqual([]);
    expect(chunker.flush("build")).toEqual([]);
    expect(chunker.msUntilNextFlush()).toBeNull();
  });

  it("starts the notice on its own line when the cap falls mid-line", () => {
    const { chunker } = setup(SMALL);

    const chunks = chunker.push(
      "build",
      ("u".repeat(999) + "\n").repeat(4) + "u".repeat(200),
    );
    const notice = chunks.find((chunk) => chunk.kind === "phase_truncated");

    expect(notice?.text.startsWith("\n[noodara]")).toBe(true);
  });

  it("cuts at the cap on a character boundary", () => {
    const { chunker } = setup(SMALL);

    const chunks = chunker.push("build", ("€".repeat(300) + "\n").repeat(5));
    const text = outputText(chunks);

    expect(byteLength(text)).toBeLessThanOrEqual(4096);
    expect(text.includes("�")).toBe(false);
  });

  it("caps one phase without affecting another", () => {
    const { chunker } = setup(SMALL);
    chunker.push("build", ("v".repeat(99) + "\n").repeat(50));

    chunker.push("deploy", "started\n");

    expect(
      chunker.flush("deploy").map((chunk) => [chunk.text, chunk.seq]),
    ).toEqual([["started\n", 1]]);
  });

  it("holds the default 10 MiB per phase", () => {
    const { chunker } = setup();
    const line = "m".repeat(8191) + "\n";
    const chunks: BuildLogChunk[] = [];

    for (let i = 0; i < 1400; i += 1)
      chunks.push(...chunker.push("build", line));
    chunks.push(...chunker.flush());

    expect(
      chunks
        .filter((chunk) => chunk.kind === "output")
        .reduce((sum, c) => sum + c.byteLength, 0),
    ).toBe(10 * 1024 * 1024);
    expect(
      chunks.filter((chunk) => chunk.kind === "phase_truncated"),
    ).toHaveLength(1);
    expect(chunks.every((chunk) => chunk.byteLength <= 16_384)).toBe(true);
  });
});

// Deterministic PRNG (mulberry32) so the property run is reproducible.
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = ["a", "b", " ", "\n", "\n", "€", "🚀", "é", "\t"];

describe("chunker invariants (property)", () => {
  it("is lossless below the caps, keeps seq contiguous and bounds every chunk", () => {
    const next = prng(0xc4a2_1203);

    for (let run = 0; run < 200; run += 1) {
      const { clock, chunker } = setup({
        flushBytes: 1024,
        maxLineBytes: 2048,
        maxPhaseBytes: 1_048_576,
      });
      const chunks: BuildLogChunk[] = [];
      let input = "";

      for (let push = 0; push < 30; push += 1) {
        const length = Math.floor(next() * 400);
        let text = "";
        for (let i = 0; i < length; i += 1)
          text += ALPHABET[Math.floor(next() * ALPHABET.length)] ?? "";
        input += text;
        chunks.push(...chunker.push("build", text));
        clock.advance(Math.floor(next() * 200));
        if (next() < 0.3) chunks.push(...chunker.tick());
      }
      chunks.push(...chunker.flush());
      const expected =
        input.length === 0 || input.endsWith("\n") ? input : `${input}\n`;

      expect(outputText(chunks)).toBe(expected);
      expect(chunks.map((chunk) => chunk.seq)).toEqual(
        chunks.map((_c, index) => index + 1),
      );
      expect(
        chunks.every((chunk) => chunk.byteLength === byteLength(chunk.text)),
      ).toBe(true);
      expect(
        chunks.every(
          (chunk) => chunk.byteLength <= 2048 && chunk.byteLength > 0,
        ),
      ).toBe(true);
    }
  });

  it("never emits a line over the cap however the input is split", () => {
    const next = prng(0x0bad_cafe);

    for (let run = 0; run < 100; run += 1) {
      const { clock, chunker } = setup(SMALL);
      const chunks: BuildLogChunk[] = [];

      for (let push = 0; push < 40; push += 1) {
        const text =
          (next() < 0.1 ? "\n" : "") + "€🚀x".repeat(Math.floor(next() * 120));
        chunks.push(...chunker.push("build", text));
        clock.advance(Math.floor(next() * 400));
        chunks.push(...chunker.tick());
      }
      chunks.push(...chunker.flush());

      for (const line of outputText(chunks).split("\n")) {
        expect(byteLength(line)).toBeLessThanOrEqual(1024);
      }
      expect(outputText(chunks).includes("�")).toBe(false);
    }
  });
});
