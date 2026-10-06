// 13-05: the runtime-log follow reader (A3, H3). Two layers: a controlled in-memory body to pin
// framing, caps and reader release exactly, and a real local HTTP server behind the relative
// `/api/...` fetch, so abort and server end are proven to close the actual connection.
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  followRuntimeLogs,
  type RuntimeLogFollowResult,
  type StreamedLogLine,
} from "./runtime-log-stream";

const P = "11111111-1111-4111-8111-111111111111";
const S = "33333333-3333-4333-8333-333333333333";
const TS = "2026-10-06T10:00:00.000000000Z";

const REAL_FETCH = globalThis.fetch.bind(globalThis);
const REAL_SET_TIMEOUT = globalThis.setTimeout.bind(globalThis);

function lineFrame(
  text: string,
  stream: "stdout" | "stderr" = "stdout",
): string {
  return `${JSON.stringify({ type: "line", stream, timestamp: TS, text })}\n`;
}

function endFrame(reason: string): string {
  return `${JSON.stringify({ type: "end", reason })}\n`;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => REAL_SET_TIMEOUT(resolve, ms));
}

async function withGuard<T>(
  promise: Promise<T>,
  ms = 3000,
): Promise<T | "timed-out"> {
  const guard = new Promise<"timed-out">((resolve) => {
    REAL_SET_TIMEOUT(() => {
      resolve("timed-out");
    }, ms);
  });
  return Promise.race([promise, guard]);
}

interface ControlledBody {
  readonly response: Response;
  readonly body: ReadableStream<Uint8Array>;
  push(text: string): void;
  pushBytes(bytes: Uint8Array): void;
  close(): void;
  fail(): void;
  readonly cancelled: () => boolean;
}

function controlledBody(): ControlledBody {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      cancelled = true;
    },
  });
  const encoder = new TextEncoder();
  const ctrl = (): ReadableStreamDefaultController<Uint8Array> => {
    if (controller === undefined) throw new Error("stream not started");
    return controller;
  };
  const response = new Response(body, {
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
  });
  return {
    response,
    body,
    push: (text) => {
      ctrl().enqueue(encoder.encode(text));
    },
    pushBytes: (bytes) => {
      ctrl().enqueue(bytes);
    },
    close: () => {
      ctrl().close();
    },
    fail: () => {
      ctrl().error(new TypeError("terminated"));
    },
    cancelled: () => cancelled,
  };
}

function texts(lines: readonly StreamedLogLine[]): string[] {
  return lines.map((line) => line.text);
}

describe("followRuntimeLogs (controlled body)", () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function open(
    body: ControlledBody,
    extra: Partial<Parameters<typeof followRuntimeLogs>[0]> = {},
  ) {
    fetchMock.mockResolvedValueOnce(body.response);
    return followRuntimeLogs({ projectId: P, serviceId: S, ...extra });
  }

  it("requests the follow path same-origin as NDJSON with the caller tail", async () => {
    const body = controlledBody();
    body.push(endFrame("container_exited"));
    const follow = open(body, { tail: 100 });

    await follow.done;

    const [path, init] = fetchMock.mock.calls[0] ?? [];
    expect(path).toBe(`/api/projects/${P}/services/${S}/logs/follow?tail=100`);
    expect(init?.method).toBe("GET");
    expect(init?.credentials).toBe("same-origin");
    expect(init?.headers).toEqual({ Accept: "application/x-ndjson" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("reassembles a frame split across reads, including a split multi-byte character", async () => {
    const body = controlledBody();
    const frame = new TextEncoder().encode(lineFrame("café ready"));
    const cut = frame.indexOf(0xc3) + 1; // inside the two-byte "é"
    const follow = open(body);

    body.pushBytes(frame.slice(0, 10));
    await tick();
    body.pushBytes(frame.slice(10, cut));
    await tick();
    body.pushBytes(frame.slice(cut));
    body.push(endFrame("container_exited"));

    await expect(follow.done).resolves.toEqual({
      ok: true,
      reason: "server_end",
      serverReason: "container_exited",
    });
    expect(follow.snapshot().lines).toEqual([
      { stream: "stdout", timestamp: TS, text: "café ready", truncated: false },
    ]);
  });

  it("skips malformed lines without ending the stream", async () => {
    const body = controlledBody();
    body.push("not json\n");
    body.push("42\n");
    body.push('{"type":"line","stream":"stdin","timestamp":null,"text":"x"}\n');
    body.push('{"type":"line","stream":"stdout","timestamp":7,"text":"x"}\n');
    body.push('{"type":"progress"}\n');
    body.push("\n");
    body.push(lineFrame("still here", "stderr"));
    body.push(endFrame("max_duration"));
    const follow = open(body);

    await expect(follow.done).resolves.toEqual({
      ok: true,
      reason: "server_end",
      serverReason: "max_duration",
    });
    expect(texts(follow.snapshot().lines)).toEqual(["still here"]);
    expect(follow.snapshot().skippedFrames).toBe(5);
  });

  it("truncates a line over the client cap and marks it", async () => {
    const body = controlledBody();
    body.push(lineFrame("abcdefghij"));
    body.push(lineFrame("abc"));
    body.push(endFrame("container_exited"));
    const follow = open(body, { limits: { maxLineChars: 5 } });

    await follow.done;

    expect(follow.snapshot().lines.map((l) => [l.text, l.truncated])).toEqual([
      ["abcde", true],
      ["abc", false],
    ]);
  });

  it("drops an oversized frame without buffering it and keeps reading", async () => {
    const body = controlledBody();
    const follow = open(body, { limits: { maxFrameChars: 100 } });

    body.push(
      `{"type":"line","stream":"stdout","timestamp":null,"text":"${"x".repeat(80)}`,
    );
    await tick();
    body.push("y".repeat(80));
    await tick();
    body.push(`${"z".repeat(80)}"}\n`);
    body.push(lineFrame("after"));
    body.push(endFrame("container_exited"));

    await follow.done;
    expect(texts(follow.snapshot().lines)).toEqual(["after"]);
    expect(follow.snapshot().skippedFrames).toBe(1);
  });

  it("caps the buffered lines, dropping the oldest", async () => {
    const body = controlledBody();
    for (let i = 1; i <= 5; i += 1) body.push(lineFrame(`line ${String(i)}`));
    body.push(endFrame("container_exited"));
    const batches: (readonly StreamedLogLine[])[] = [];
    const follow = open(body, {
      limits: { maxBufferedLines: 3 },
      onLines: (lines) => batches.push(lines),
    });

    await follow.done;

    expect(texts(follow.snapshot().lines)).toEqual([
      "line 3",
      "line 4",
      "line 5",
    ]);
    expect(follow.snapshot().droppedLines).toBe(2);
    expect(batches.every((batch) => batch.length <= 3)).toBe(true);
  });

  it("stops on the server end frame and releases the reader", async () => {
    const body = controlledBody();
    body.push(lineFrame("one"));
    body.push(endFrame("container_exited"));
    body.push(lineFrame("after end, ignored"));
    const follow = open(body);

    await expect(follow.done).resolves.toEqual({
      ok: true,
      reason: "server_end",
      serverReason: "container_exited",
    });
    expect(texts(follow.snapshot().lines)).toEqual(["one"]);
    expect(body.cancelled()).toBe(true);
    expect(body.body.locked).toBe(false);
  });

  it("maps an unknown end reason to unknown", async () => {
    const body = controlledBody();
    body.push(endFrame("meteor"));

    await expect(open(body).done).resolves.toEqual({
      ok: true,
      reason: "server_end",
      serverReason: "unknown",
    });
  });

  it("accepts a final end frame with no trailing newline", async () => {
    const body = controlledBody();
    body.push(lineFrame("one"));
    body.push(JSON.stringify({ type: "end", reason: "shutdown" }));
    body.close();

    await expect(open(body).done).resolves.toEqual({
      ok: true,
      reason: "server_end",
      serverReason: "shutdown",
    });
  });

  it("stops on caller abort and releases the reader", async () => {
    const body = controlledBody();
    const controller = new AbortController();
    const seen: string[] = [];
    const follow = open(body, {
      signal: controller.signal,
      onLines: (lines) => seen.push(...texts(lines)),
    });
    body.push(lineFrame("first"));
    await tick(5);

    controller.abort();

    await expect(withGuard(follow.done)).resolves.toEqual({
      ok: true,
      reason: "aborted",
    });
    expect(seen).toEqual(["first"]);
    expect(body.cancelled()).toBe(true);
    expect(body.body.locked).toBe(false);
  });

  it("does not fetch when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const follow = followRuntimeLogs({
      projectId: P,
      serviceId: S,
      signal: controller.signal,
    });

    await expect(follow.done).resolves.toEqual({ ok: true, reason: "aborted" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves a body that closes without an end frame to NETWORK_ERROR and releases it", async () => {
    const body = controlledBody();
    body.push(lineFrame("one"));
    body.close();
    const follow = open(body);

    await expect(follow.done).resolves.toMatchObject({
      ok: false,
      code: "NETWORK_ERROR",
    });
    expect(texts(follow.snapshot().lines)).toEqual(["one"]);
    expect(body.body.locked).toBe(false);
  });

  it("resolves a body that errors mid-stream to NETWORK_ERROR and releases it", async () => {
    const body = controlledBody();
    const follow = open(body);
    body.push(lineFrame("one"));
    await tick();
    body.fail();

    await expect(follow.done).resolves.toMatchObject({
      ok: false,
      code: "NETWORK_ERROR",
    });
    expect(body.body.locked).toBe(false);
  });

  it("ends at the client max duration and releases the reader", async () => {
    const body = controlledBody();
    body.push(lineFrame("one"));
    const follow = open(body, { limits: { maxDurationMs: 30 } });

    await expect(withGuard(follow.done)).resolves.toEqual({
      ok: true,
      reason: "max_duration",
    });
    expect(body.cancelled()).toBe(true);
    expect(body.body.locked).toBe(false);
  });

  it("resolves to NETWORK_ERROR when the headers never arrive within the open timeout", async () => {
    fetchMock.mockImplementationOnce(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );

    const follow = followRuntimeLogs({
      projectId: P,
      serviceId: S,
      limits: { openTimeoutMs: 20 },
    });

    await expect(withGuard(follow.done)).resolves.toMatchObject({
      ok: false,
      code: "NETWORK_ERROR",
    });
  });

  it.each([
    [429, "RUNTIME_LOG_FOLLOW_LIMIT_REACHED"],
    [502, "RUNTIME_LOGS_FAILED"],
    [504, "RUNTIME_LOGS_TIMEOUT"],
    [409, "CONTAINER_NOT_FOUND"],
    [422, "RUNTIME_LOG_TAIL_INVALID"],
    [404, "NOT_FOUND"],
  ])("surfaces a %i %s as a typed error", async (status, code) => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(status, { error: code, message: "Fixed copy." }),
    );

    const result: RuntimeLogFollowResult = await followRuntimeLogs({
      projectId: P,
      serviceId: S,
    }).done;

    expect(result).toEqual({
      ok: false,
      code,
      message: "Fixed copy.",
      unauthorized: false,
    });
  });

  it("surfaces a 401 as session expired", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, {
        error: "UNAUTHORIZED",
        message: "Not authenticated",
      }),
    );

    const result = await followRuntimeLogs({ projectId: P, serviceId: S }).done;

    expect(result).toMatchObject({
      ok: false,
      code: "UNAUTHORIZED",
      unauthorized: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("resolves a rejected fetch to NETWORK_ERROR without echoing its message", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("internal-resolver-detail"));

    const result = await followRuntimeLogs({ projectId: P, serviceId: S }).done;

    expect(result).toMatchObject({ ok: false, code: "NETWORK_ERROR" });
    expect(JSON.stringify(result)).not.toContain("internal-resolver-detail");
  });

  it("rejects an unsafe id without any request", async () => {
    const result = await followRuntimeLogs({
      projectId: P,
      serviceId: "../servers",
    }).done;

    expect(result).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never writes line text to the console", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map(
      (method) => vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const body = controlledBody();
    body.push(lineFrame("DATABASE_PASSWORD=hunter2"));
    body.push("garbage\n");
    body.push(endFrame("container_exited"));

    await open(body).done;

    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe("followRuntimeLogs (real HTTP connection)", () => {
  type Handler = (req: IncomingMessage, res: ServerResponse) => void;
  let server: Server;
  let base = "";
  let handler: Handler = (_req, res) => {
    res.writeHead(500).end();
  };

  beforeAll(async () => {
    server = createServer((req, res) => {
      handler(req, res);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  beforeEach(() => {
    // The client only ever uses relative `/api/...` paths; route them to the local server.
    vi.stubGlobal(
      "fetch",
      (input: string | URL | Request, init?: RequestInit) =>
        REAL_FETCH(
          new URL(
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.href
                : input.url,
            base,
          ),
          init,
        ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function ndjsonHead(res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
    });
  }

  it("reads frames split at arbitrary byte boundaries until the server end frame", async () => {
    const payload = `${lineFrame("booting")}${lineFrame("listening on :3000", "stderr")}${endFrame("container_exited")}`;
    let requestedUrl = "";
    handler = (req, res) => {
      requestedUrl = req.url ?? "";
      ndjsonHead(res);
      const bytes = Buffer.from(payload);
      let offset = 0;
      const step = (): void => {
        if (offset >= bytes.length) {
          res.end();
          return;
        }
        res.write(bytes.subarray(offset, offset + 7));
        offset += 7;
        REAL_SET_TIMEOUT(step, 1);
      };
      step();
    };

    const follow = followRuntimeLogs({ projectId: P, serviceId: S, tail: 10 });

    await expect(withGuard(follow.done)).resolves.toEqual({
      ok: true,
      reason: "server_end",
      serverReason: "container_exited",
    });
    expect(requestedUrl).toBe(
      `/api/projects/${P}/services/${S}/logs/follow?tail=10`,
    );
    expect(follow.snapshot().lines.map((l) => [l.stream, l.text])).toEqual([
      ["stdout", "booting"],
      ["stderr", "listening on :3000"],
    ]);
  });

  it("closes the connection on caller abort (no leaked socket)", async () => {
    let closed: Promise<void> = Promise.resolve();
    handler = (_req, res) => {
      closed = new Promise<void>((resolve) => {
        res.on("close", () => {
          resolve();
        });
      });
      ndjsonHead(res);
      res.write(lineFrame("first"));
      // Keeps the stream open: only the client can end it.
    };
    const controller = new AbortController();
    const follow = followRuntimeLogs({
      projectId: P,
      serviceId: S,
      signal: controller.signal,
      onLines: () => {
        controller.abort();
      },
    });

    await expect(withGuard(follow.done)).resolves.toEqual({
      ok: true,
      reason: "aborted",
    });
    await expect(withGuard(closed.then(() => "closed" as const))).resolves.toBe(
      "closed",
    );
    expect(follow.snapshot().lines.map((l) => l.text)).toEqual(["first"]);
  });

  it("closes the connection after the end frame even if the server keeps it open", async () => {
    let closed: Promise<void> = Promise.resolve();
    handler = (_req, res) => {
      closed = new Promise<void>((resolve) => {
        res.on("close", () => {
          resolve();
        });
      });
      ndjsonHead(res);
      res.write(endFrame("output_limit"));
    };

    const follow = followRuntimeLogs({ projectId: P, serviceId: S });

    await expect(withGuard(follow.done)).resolves.toEqual({
      ok: true,
      reason: "server_end",
      serverReason: "output_limit",
    });
    await expect(withGuard(closed.then(() => "closed" as const))).resolves.toBe(
      "closed",
    );
  });

  it("surfaces the 429 follow limit as RUNTIME_LOG_FOLLOW_LIMIT_REACHED", async () => {
    handler = (_req, res) => {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "RUNTIME_LOG_FOLLOW_LIMIT_REACHED",
          message: "Too many log streams.",
        }),
      );
    };

    const result = await withGuard(
      followRuntimeLogs({ projectId: P, serviceId: S }).done,
    );

    expect(result).toEqual({
      ok: false,
      code: "RUNTIME_LOG_FOLLOW_LIMIT_REACHED",
      message: "Too many log streams.",
      unauthorized: false,
    });
  });

  it("resolves a connection dropped mid-stream to NETWORK_ERROR", async () => {
    handler = (req, res) => {
      ndjsonHead(res);
      res.write(lineFrame("one"));
      REAL_SET_TIMEOUT(() => {
        req.socket.destroy();
      }, 10);
    };

    const follow = followRuntimeLogs({ projectId: P, serviceId: S });

    await expect(withGuard(follow.done)).resolves.toMatchObject({
      ok: false,
      code: "NETWORK_ERROR",
    });
    expect(follow.snapshot().lines.map((l) => l.text)).toEqual(["one"]);
  });
});
