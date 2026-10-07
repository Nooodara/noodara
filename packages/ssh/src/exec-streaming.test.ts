// Fake-channel, fake-timer unit tests for the streaming exec (11-14, ROADMAP criterion 4, QA-10).
// The behaviour under test is stream and timer mechanics; the real sshd + dockerd proof lives in
// tests/integration/deploy-engine/exec-streaming.test.ts.
import { createRedactor, SecretValue } from "@noodara/domain/security";
import {
  deployWorkspaceFor,
  type DeployWorkspace,
} from "@noodara/domain/validators";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderRemoteCommand, type RemoteCommand } from "./commands/index.js";
import { prepareWorkspace, writeSecretFile } from "./commands/workspace.js";
import { TransportClosedError } from "./errors.js";
import {
  DEFAULT_MAX_LINE_BYTES,
  DEFAULT_TAIL_BYTES,
  execStreaming,
  registerSecretForStreaming,
  REDACTION_LOOKAHEAD_BYTES,
  type StreamChannel,
} from "./exec-streaming.js";
import type { StreamChunk, StreamOptions } from "./ssh-port.js";

class FakeChannel implements StreamChannel {
  readonly dataListeners: ((chunk: Buffer) => void)[] = [];
  readonly closeListeners: ((code: number | null, signal?: string) => void)[] =
    [];
  readonly errorListeners: ((err: Error) => void)[] = [];
  readonly stderrDataListeners: ((chunk: Buffer) => void)[] = [];
  readonly writes: string[] = [];
  destroyCalls = 0;
  endCalls = 0;

  readonly stderr = {
    on: (_event: "data", listener: (chunk: Buffer) => void): void => {
      this.stderrDataListeners.push(listener);
    },
  };

  on(event: "data", listener: (chunk: Buffer) => void): void;
  on(
    event: "close",
    listener: (code: number | null, signal?: string) => void,
  ): void;
  on(event: "error", listener: (err: Error) => void): void;
  on(
    event: "data" | "close" | "error",
    listener:
      | ((chunk: Buffer) => void)
      | ((code: number | null, signal?: string) => void)
      | ((err: Error) => void),
  ): void {
    if (event === "data") {
      this.dataListeners.push(listener as (chunk: Buffer) => void);
    } else if (event === "close") {
      this.closeListeners.push(
        listener as (code: number | null, signal?: string) => void,
      );
    } else {
      this.errorListeners.push(listener as (err: Error) => void);
    }
  }

  write(data: string | Buffer): boolean {
    this.writes.push(data.toString());
    return true;
  }

  end(): void {
    this.endCalls += 1;
  }

  destroy(): void {
    this.destroyCalls += 1;
  }

  out(text: string | Buffer): void {
    const chunk = typeof text === "string" ? Buffer.from(text, "utf8") : text;
    for (const listener of this.dataListeners) listener(chunk);
  }

  err(text: string): void {
    for (const listener of this.stderrDataListeners)
      listener(Buffer.from(text, "utf8"));
  }

  close(code: number | null, signal?: string): void {
    for (const listener of this.closeListeners) listener(code, signal);
  }

  fail(error: Error): void {
    for (const listener of this.errorListeners) listener(error);
  }
}

class FakeClient {
  readonly commands: string[] = [];
  private callback:
    ((err: Error | undefined, channel: StreamChannel) => void) | undefined;

  exec(
    command: string,
    callback: (err: Error | undefined, channel: StreamChannel) => void,
  ): void {
    this.commands.push(command);
    this.callback = callback;
  }

  deliver(channel: FakeChannel): void {
    this.callback?.(undefined, channel);
  }

  refuse(error: Error): void {
    this.callback?.(error, new FakeChannel());
  }
}

function workspace(): DeployWorkspace {
  const result = deployWorkspaceFor("3f2b8c1e-9d4a-4f6b-8a2c-1e5d7f9b0c3a");
  if (!result.ok) throw new Error("test setup: workspace");
  return result.value;
}

function setup(
  overrides: Partial<StreamOptions> = {},
  command: RemoteCommand = prepareWorkspace(workspace()),
) {
  const redactor = createRedactor();
  const client = new FakeClient();
  const channel = new FakeChannel();
  const chunks: StreamChunk[] = [];
  const options: StreamOptions = {
    maxDurationMs: 60_000,
    idleTimeoutMs: 10_000,
    maxTotalBytes: 1_000_000,
    maxLineBytes: DEFAULT_MAX_LINE_BYTES,
    onChunk: (chunk) => {
      chunks.push(chunk);
    },
    ...overrides,
  };
  const start = () => {
    const promise = execStreaming({ client, command, options, redactor });
    client.deliver(channel);
    return promise;
  };
  return { redactor, client, channel, chunks, options, command, start };
}

const texts = (chunks: readonly StreamChunk[]): string[] =>
  chunks.map((chunk) => chunk.text);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("execStreaming: line chunks (criterion 4)", () => {
  it("delivers only complete lines, with increasing seq, tagging stdout and stderr", async () => {
    const t = setup();
    const promise = t.start();

    t.channel.out("hello\nwor");
    t.channel.out("ld\n");
    t.channel.err("warn\n");
    t.channel.close(0);
    const result = await promise;

    expect(texts(t.chunks)).toEqual(["hello\n", "world\n", "warn\n"]);
    expect(t.chunks.map((chunk) => chunk.seq)).toEqual([0, 1, 2]);
    expect(t.chunks.map((chunk) => chunk.stream)).toEqual([
      "stdout",
      "stdout",
      "stderr",
    ]);
    expect(t.chunks.every((chunk) => !chunk.truncatedLine)).toBe(true);
    expect(result).toMatchObject({
      commandName: "fs.prepare_workspace",
      outcome: "completed",
      exitCode: 0,
      exitSignal: null,
      truncated: false,
      totalBytes: "hello\nworld\nwarn\n".length,
    });
  });

  it("groups every complete line of one data event into one chunk", async () => {
    const t = setup();
    const promise = t.start();

    t.channel.out("a\nb\nc");
    t.channel.close(0);
    await promise;

    expect(texts(t.chunks)).toEqual(["a\nb\n", "c"]);
  });

  it("keeps stdout and stderr partial lines in separate buffers", async () => {
    const t = setup();
    const promise = t.start();

    t.channel.out("out-");
    t.channel.err("err-");
    t.channel.out("line\n");
    t.channel.err("line\n");
    t.channel.close(0);
    await promise;

    expect(texts(t.chunks)).toEqual(["out-line\n", "err-line\n"]);
  });

  it("flushes a partial last line (no trailing newline) at close", async () => {
    const t = setup();
    const promise = t.start();

    t.channel.out("done\nno newline");
    t.channel.err("tail");
    t.channel.close(1);
    const result = await promise;

    expect(texts(t.chunks)).toEqual(["done\n", "no newline", "tail"]);
    expect(result.exitCode).toBe(1);
  });

  it("sends exactly renderRemoteCommand(command) to client.exec", async () => {
    const t = setup();
    const promise = t.start();
    t.channel.close(0);
    await promise;

    expect(t.client.commands).toEqual([renderRemoteCommand(t.command)]);
  });

  it("reports the exit signal ssh2 passes on close", async () => {
    const t = setup();
    const promise = t.start();
    t.channel.close(null, "SIGTERM");

    expect(await promise).toMatchObject({
      outcome: "completed",
      exitCode: null,
      exitSignal: "SIGTERM",
    });
  });

  it("keeps streaming when onChunk throws", async () => {
    const t = setup({
      onChunk: () => {
        throw new Error("consumer bug");
      },
    });
    const promise = t.start();
    t.channel.out("x\n");
    t.channel.close(0);

    expect(await promise).toMatchObject({ outcome: "completed", exitCode: 0 });
  });
});

describe("execStreaming: redaction per chunk (T-11-39)", () => {
  it("never leaks a registered secret split across two data events", async () => {
    const t = setup();
    const secret = "token123-very-secret-value";
    t.redactor.register(secret, "token");
    const promise = t.start();

    t.channel.out("auth: tok");
    t.channel.out("en123-very-secret-value ok\n");
    t.channel.close(0);
    const result = await promise;

    expect(texts(t.chunks)).toEqual(["auth: [REDACTED:token] ok\n"]);
    expect(result.stdoutTail).not.toContain("token123");
  });

  it("redacts every line of a multi-line secret registered with registerSecretForStreaming", async () => {
    const t = setup();
    const secret = [
      "-----BEGIN TEST SECRET-----",
      "c2VjcmV0LWxpbmUtb25lLWFhYWFhYWFh",
      "c2VjcmV0LWxpbmUtdHdvLWJiYmJiYmJi",
      "-----END TEST SECRET-----",
    ].join("\n");
    const unregister = registerSecretForStreaming(
      t.redactor,
      secret,
      "deploy_key",
    );
    const promise = t.start();

    for (const line of secret.split("\n")) t.channel.out(`${line}\n`);
    t.channel.out(`${secret}\n`);
    t.channel.close(0);
    await promise;

    const all = texts(t.chunks).join("");
    for (const line of secret.split("\n")) expect(all).not.toContain(line);
    expect(all).toContain("[REDACTED:deploy_key]");

    unregister();
    expect(t.redactor.redact("c2VjcmV0LWxpbmUtb25lLWFhYWFhYWFh")).toBe(
      "c2VjcmV0LWxpbmUtb25lLWFhYWFhYWFh",
    );
  });

  it("registerSecretForStreaming skips lines shorter than 8 characters and empty values", () => {
    const redactor = createRedactor();
    registerSecretForStreaming(redactor, "short\nlonger-line-here", "token");
    registerSecretForStreaming(redactor, "", "token");

    expect(redactor.redact("short")).toBe("short");
    expect(redactor.redact("longer-line-here")).toBe("[REDACTED:token]");
  });

  it("registerSecretForStreaming handles CRLF lines", () => {
    const redactor = createRedactor();
    registerSecretForStreaming(
      redactor,
      "first-line-aaaa\r\nsecond-line-bbbb\r\n",
      "token",
    );

    expect(redactor.redact("second-line-bbbb")).toBe("[REDACTED:token]");
  });

  it("redacts a secret straddling the per-line truncation point", async () => {
    const t = setup({ maxLineBytes: 10 });
    const secret = "ABCDEFGHIJKLMNOPQRST";
    t.redactor.register(secret, "token");
    const promise = t.start();

    t.channel.out(`xxxxxxxx${secret}\n`);
    t.channel.close(0);
    await promise;

    expect(texts(t.chunks)).toEqual(["xxxxxxxx[R\n"]);
    expect(t.chunks[0]?.truncatedLine).toBe(true);
  });
});

describe("execStreaming: caps (T-11-40)", () => {
  it("truncates a line longer than maxLineBytes and drops the rest of it", async () => {
    const t = setup({ maxLineBytes: 10 });
    const promise = t.start();

    t.channel.out("abcdefghijklmnop\nnext\n");
    t.channel.close(0);
    const result = await promise;

    expect(texts(t.chunks)).toEqual(["abcdefghij\nnext\n"]);
    expect(t.chunks[0]?.truncatedLine).toBe(true);
    expect(result.truncated).toBe(true);
  });

  it("cuts an over-long line without a newline once the lookahead fills, then drops until newline", async () => {
    const t = setup({ maxLineBytes: 10 });
    const promise = t.start();
    const long = "z".repeat(10 + REDACTION_LOOKAHEAD_BYTES + 1);

    t.channel.out(long.slice(0, 20));
    expect(t.chunks).toHaveLength(0);
    t.channel.out(long.slice(20));
    expect(texts(t.chunks)).toEqual(["zzzzzzzzzz\n"]);
    t.channel.out("more-dropped");
    t.channel.out("-still\nkept\n");
    t.channel.close(0);
    await promise;

    expect(texts(t.chunks)).toEqual(["zzzzzzzzzz\n", "kept\n"]);
    expect(t.chunks[0]?.truncatedLine).toBe(true);
    expect(t.chunks[1]?.truncatedLine).toBe(false);
  });

  it("drops the rest of a cut line that ends with the stream (no newline)", async () => {
    const t = setup({ maxLineBytes: 4 });
    const promise = t.start();

    t.channel.out("y".repeat(4 + REDACTION_LOOKAHEAD_BYTES + 1));
    t.channel.out("trailing");
    t.channel.close(0);
    await promise;

    expect(texts(t.chunks)).toEqual(["yyyy\n"]);
  });

  it("truncates a flushed final partial line to maxLineBytes", async () => {
    const t = setup({ maxLineBytes: 3 });
    const promise = t.start();

    t.channel.out("abcdef");
    t.channel.close(0);
    await promise;

    expect(texts(t.chunks)).toEqual(["abc"]);
    expect(t.chunks[0]?.truncatedLine).toBe(true);
  });

  it("cuts multi-byte UTF-8 safely (no U+FFFD)", async () => {
    const t = setup({ maxLineBytes: 5 });
    const promise = t.start();

    t.channel.out("aaaa€b\n");
    t.channel.out(Buffer.from("ééé\n", "utf8"));
    t.channel.close(0);
    await promise;

    const all = texts(t.chunks).join("");
    expect(texts(t.chunks)).toEqual(["aaaa\n", "éé\n"]);
    expect(all).not.toContain("�");
  });

  it("reassembles a multi-byte character split across data events", async () => {
    const t = setup();
    const bytes = Buffer.from("café\n", "utf8");
    const promise = t.start();

    t.channel.out(bytes.subarray(0, 4));
    t.channel.out(bytes.subarray(4));
    t.channel.close(0);
    await promise;

    expect(texts(t.chunks)).toEqual(["café\n"]);
  });

  it("stops delivering after maxTotalBytes, keeps draining until close, outcome completed", async () => {
    const t = setup({ maxTotalBytes: 12 });
    const promise = t.start();

    t.channel.out("aaaaa\n");
    t.channel.err("bbbbb\n");
    t.channel.out("ccccc\n");
    t.channel.out("ddddd\n");
    t.channel.close(0);
    const result = await promise;

    expect(texts(t.chunks)).toEqual(["aaaaa\n", "bbbbb\n"]);
    expect(result).toMatchObject({
      outcome: "completed",
      truncated: true,
      totalBytes: 24,
      exitCode: 0,
    });
    expect(result.stdoutTail).toBe("aaaaa\nccccc\nddddd\n");
  });

  it("delivers the lines of one event that still fit before the total cap", async () => {
    const t = setup({ maxTotalBytes: 8 });
    const promise = t.start();

    t.channel.out("aaa\nbbb\nccc\n");
    t.channel.close(0);
    const result = await promise;

    expect(texts(t.chunks)).toEqual(["aaa\nbbb\n"]);
    expect(result.truncated).toBe(true);
  });

  it("keeps the last DEFAULT_TAIL_BYTES of redacted output per stream", async () => {
    const t = setup({ maxTotalBytes: 100 });
    const promise = t.start();
    const line = `${"q".repeat(99)}\n`;

    for (let i = 0; i < 200; i += 1) t.channel.err(line);
    t.channel.err("LAST-é-LINE\n");
    t.channel.close(0);
    const result = await promise;

    expect(Buffer.byteLength(result.stderrTail, "utf8")).toBeLessThanOrEqual(
      DEFAULT_TAIL_BYTES,
    );
    expect(result.stderrTail.endsWith("LAST-é-LINE\n")).toBe(true);
    expect(result.stderrTail).not.toContain("�");
    expect(result.stdoutTail).toBe("");
  });

  it("trims a tail cut that lands inside a multi-byte character", async () => {
    const t = setup({ maxLineBytes: DEFAULT_TAIL_BYTES * 2 });
    const promise = t.start();
    // 1 ASCII byte then 2-byte characters: the 8 KiB cut lands on a continuation byte.
    t.channel.out(`a${"é".repeat(DEFAULT_TAIL_BYTES)}\n`);
    t.channel.close(0);
    const result = await promise;

    expect(result.stdoutTail).not.toContain("�");
    expect(Buffer.byteLength(result.stdoutTail, "utf8")).toBeLessThanOrEqual(
      DEFAULT_TAIL_BYTES,
    );
  });

  it.each([
    ["maxDurationMs", { maxDurationMs: 0 }],
    ["idleTimeoutMs", { idleTimeoutMs: -1 }],
    ["maxTotalBytes", { maxTotalBytes: 1.5 }],
    ["maxLineBytes", { maxLineBytes: 0 }],
  ] as const)(
    "rejects a non-positive-integer %s without opening a channel",
    async (_name, bad) => {
      const t = setup(bad);
      await expect(
        execStreaming({
          client: t.client,
          command: t.command,
          options: t.options,
          redactor: t.redactor,
        }),
      ).rejects.toThrow(RangeError);
      expect(t.client.commands).toHaveLength(0);
    },
  );
});

describe("execStreaming: timeouts and abort (D15 groundwork)", () => {
  it("destroys the channel and resolves timed_out after maxDurationMs; a later close is ignored", async () => {
    const t = setup({ maxDurationMs: 1_000, idleTimeoutMs: 5_000 });
    const promise = t.start();

    t.channel.out("partial");
    await vi.advanceTimersByTimeAsync(1_000);
    t.channel.close(0);
    const result = await promise;

    expect(result).toMatchObject({ outcome: "timed_out", exitCode: null });
    expect(t.channel.destroyCalls).toBe(1);
    expect(texts(t.chunks)).toEqual(["partial"]);
  });

  it("resolves idle_timeout after idleTimeoutMs without data; each data event resets the idle timer", async () => {
    const t = setup({ maxDurationMs: 60_000, idleTimeoutMs: 1_000 });
    const promise = t.start();

    await vi.advanceTimersByTimeAsync(900);
    t.channel.out("tick\n");
    await vi.advanceTimersByTimeAsync(900);
    t.channel.err("tock\n");
    await vi.advanceTimersByTimeAsync(900);
    expect(t.channel.destroyCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    const result = await promise;

    expect(result.outcome).toBe("idle_timeout");
    expect(t.channel.destroyCalls).toBe(1);
  });

  it("destroys the channel and resolves aborted when the signal aborts", async () => {
    const controller = new AbortController();
    const t = setup({ signal: controller.signal });
    const promise = t.start();

    t.channel.out("working\n");
    controller.abort();
    t.channel.out("late\n");
    const result = await promise;

    expect(result.outcome).toBe("aborted");
    expect(t.channel.destroyCalls).toBe(1);
    expect(texts(t.chunks)).toEqual(["working\n"]);
  });

  it("never opens a channel for an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const t = setup({ signal: controller.signal });

    const result = await execStreaming({
      client: t.client,
      command: t.command,
      options: t.options,
      redactor: t.redactor,
    });

    expect(result).toMatchObject({
      outcome: "aborted",
      exitCode: null,
      totalBytes: 0,
    });
    expect(t.client.commands).toHaveLength(0);
  });

  it("destroys a channel that arrives after the stream already settled", async () => {
    const controller = new AbortController();
    const t = setup({ signal: controller.signal });
    const promise = execStreaming({
      client: t.client,
      command: t.command,
      options: t.options,
      redactor: t.redactor,
    });

    controller.abort();
    expect((await promise).outcome).toBe("aborted");
    t.client.deliver(t.channel);

    expect(t.channel.destroyCalls).toBe(1);
    expect(t.channel.errorListeners).toHaveLength(1);
    expect(() => {
      t.channel.fail(new Error("late"));
    }).not.toThrow();
  });

  it("settles exactly once: a close after abort does not resolve again", async () => {
    const controller = new AbortController();
    const t = setup({ signal: controller.signal });
    const promise = t.start();

    controller.abort();
    t.channel.close(0);
    t.channel.fail(new Error("after"));

    expect((await promise).outcome).toBe("aborted");
  });

  it("clears its timers once settled", async () => {
    const t = setup({ maxDurationMs: 1_000, idleTimeoutMs: 500 });
    const promise = t.start();
    t.channel.close(0);
    await promise;

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("execStreaming: stdin and failures (T-11-42)", () => {
  it("writes the stdin secret once, then ends stdin; the plaintext never reaches a chunk or tail", async () => {
    const plaintext = "stdin-secret-value-1234567890";
    const t = setup(
      { stdin: SecretValue.from(plaintext, "ssh_private_key") },
      writeSecretFile(workspace().secretFile("deploy_key")),
    );
    const promise = t.start();

    t.channel.err(`echo ${plaintext}\n`);
    t.channel.close(0);
    const result = await promise;

    expect(t.channel.writes).toEqual([plaintext]);
    expect(t.channel.endCalls).toBe(1);
    expect(JSON.stringify(t.chunks)).not.toContain(plaintext);
    expect(JSON.stringify(result)).not.toContain(plaintext);
  });

  it("ends stdin immediately for a command without stdin", async () => {
    const t = setup();
    const promise = t.start();
    t.channel.close(0);
    await promise;

    expect(t.channel.writes).toEqual([]);
    expect(t.channel.endCalls).toBe(1);
  });

  it("rejects a secret-stdin command without options.stdin, before opening a channel", async () => {
    const t = setup({}, writeSecretFile(workspace().secretFile("deploy_key")));

    await expect(
      execStreaming({
        client: t.client,
        command: t.command,
        options: t.options,
        redactor: t.redactor,
      }),
    ).rejects.toThrow(/stdin/);
    expect(t.client.commands).toHaveLength(0);
  });

  it("rejects options.stdin for a command that takes no stdin, without leaking the value", async () => {
    const plaintext = "never-written-anywhere-123";
    const t = setup({ stdin: SecretValue.from(plaintext, "api_key") });

    const error = await execStreaming({
      client: t.client,
      command: t.command,
      options: t.options,
      redactor: t.redactor,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(plaintext);
    expect(t.client.commands).toHaveLength(0);
  });

  it("rejects with the exec error when the channel cannot be opened", async () => {
    const t = setup();
    const promise = execStreaming({
      client: t.client,
      command: t.command,
      options: t.options,
      redactor: t.redactor,
    });
    t.client.refuse(new Error("Channel open failure"));

    await expect(promise).rejects.toThrow("Channel open failure");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects with TransportClosedError when the channel emits error", async () => {
    const t = setup();
    const promise = t.start();
    t.channel.fail(new Error("boom"));

    await expect(promise).rejects.toBeInstanceOf(TransportClosedError);
  });
});

describe("execStreaming: stdin secret release (14-09)", () => {
  const plaintext = "stdin-secret-value-1234567890";
  const stdin = () => SecretValue.from(plaintext, "ssh_private_key");
  const keyCommand = () =>
    writeSecretFile(workspace().secretFile("deploy_key"));
  const registered = (redactor: ReturnType<typeof createRedactor>): boolean =>
    redactor.redact(plaintext).includes("[REDACTED");

  it("releases after the last line is redacted: success, failure, timeout, idle, abort, channel error", async () => {
    const cases: [string, (t: ReturnType<typeof setup>) => void][] = [
      [
        "success",
        (t) => {
          t.channel.close(0);
        },
      ],
      [
        "failure",
        (t) => {
          t.channel.close(1);
        },
      ],
      [
        "timeout",
        () => {
          vi.advanceTimersByTime(60_000);
        },
      ],
      [
        "idle",
        () => {
          vi.advanceTimersByTime(10_000);
        },
      ],
      [
        "abort",
        () => {
          ac.abort();
        },
      ],
      [
        "error",
        (t) => {
          t.channel.fail(new Error("boom"));
        },
      ],
    ];
    let ac = new AbortController();
    for (const [, end] of cases) {
      ac = new AbortController();
      const t = setup({ stdin: stdin(), signal: ac.signal }, keyCommand());
      const promise = t.start();
      expect(registered(t.redactor)).toBe(true);
      end(t);
      await promise.catch(() => undefined);
      expect(registered(t.redactor)).toBe(false);
    }
  });

  it("releases for an already aborted signal", async () => {
    const ac = new AbortController();
    ac.abort();
    const t = setup({ stdin: stdin(), signal: ac.signal }, keyCommand());
    await t.start();
    expect(registered(t.redactor)).toBe(false);
  });

  it("redacts an echo in the final unterminated flush, and a split across the last two chunks, with non-zero exit", async () => {
    const t = setup({ stdin: stdin() }, keyCommand());
    const promise = t.start();
    t.channel.err(plaintext.slice(0, 10));
    t.channel.err(plaintext.slice(10));
    t.channel.out(`tail ${plaintext}`);
    t.channel.close(2);
    const result = await promise;
    expect(JSON.stringify(t.chunks)).not.toContain(plaintext);
    expect(JSON.stringify(result)).not.toContain(plaintext);
    expect(t.chunks.length).toBeGreaterThan(0);
    expect(registered(t.redactor)).toBe(false);
  });

  it("releases exactly once: a late close after a timeout does not free another holder", async () => {
    const t = setup({ stdin: stdin() }, keyCommand());
    t.redactor.register(plaintext, "outer");
    const promise = t.start();
    vi.advanceTimersByTime(60_000);
    await promise;
    t.channel.close(0);
    t.channel.fail(new Error("late"));
    expect(registered(t.redactor)).toBe(true);
    t.redactor.release(plaintext);
    expect(registered(t.redactor)).toBe(false);
  });

  it("keeps a concurrent call holding the same value registered", async () => {
    const redactor = createRedactor();
    const mk = () => {
      const client = new FakeClient();
      const channel = new FakeChannel();
      const promise = execStreaming({
        client,
        command: keyCommand(),
        options: {
          maxDurationMs: 60_000,
          idleTimeoutMs: 10_000,
          maxTotalBytes: 1000,
          maxLineBytes: 100,
          onChunk: () => undefined,
          stdin: stdin(),
        },
        redactor,
      });
      client.deliver(channel);
      return { channel, promise };
    };
    const a = mk();
    const b = mk();
    a.channel.close(0);
    await a.promise;
    expect(registered(redactor)).toBe(true);
    b.channel.close(0);
    await b.promise;
    expect(registered(redactor)).toBe(false);
  });

  it("a throw in the release path does not reject or crash the stream", async () => {
    const t = setup({ stdin: stdin() }, keyCommand());
    vi.spyOn(t.redactor, "release").mockImplementation(() => {
      throw new Error("release boom");
    });
    const promise = t.start();
    t.channel.close(0);
    await expect(promise).resolves.toMatchObject({ outcome: "completed" });
  });

  it("leaves the registry empty after many streams, including aborted ones", async () => {
    const redactor = createRedactor();
    for (let i = 0; i < 50; i += 1) {
      const ac = new AbortController();
      const client = new FakeClient();
      const channel = new FakeChannel();
      const promise = execStreaming({
        client,
        command: keyCommand(),
        options: {
          maxDurationMs: 60_000,
          idleTimeoutMs: 10_000,
          maxTotalBytes: 1000,
          maxLineBytes: 100,
          onChunk: () => undefined,
          signal: ac.signal,
          stdin: SecretValue.from(
            `${plaintext}-${String(i)}\nsecond-line-${String(i)}-abcdef`,
            "ssh_private_key",
          ),
        },
        redactor,
      });
      client.deliver(channel);
      if (i % 2 === 0) ac.abort();
      else channel.close(0);
      await promise;
    }
    for (let i = 0; i < 50; i += 1) {
      expect(redactor.redact(`${plaintext}-${String(i)}`)).toBe(
        `${plaintext}-${String(i)}`,
      );
      expect(redactor.redact(`second-line-${String(i)}-abcdef`)).toBe(
        `second-line-${String(i)}-abcdef`,
      );
    }
  });
});
