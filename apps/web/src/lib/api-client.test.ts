// T-5-26/T-5-27 (05-07-PLAN.md threat register): the eight documented behaviours of apiGet/apiSend
// -- the one fetch wrapper every apps/web screen uses to reach the control plane. Stubs
// `globalThis.fetch` per case (this file runs in Vitest's `apps` project, the default node
// environment -- no DOM needed for a fetch wrapper).
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";
import type { ServiceErrorCode } from "@noodara/domain/api-contract";
import {
  ALL_DEPLOY_ENGINE_ERROR_CODES,
  ALL_KNOWN_SERVICE_ERROR_CODES,
  API_REQUEST_TIMEOUT_MS,
  apiGet,
  apiSend,
  deployApiGet,
  deployApiSend,
  type DeployApiErrorCode,
} from "./api-client";

// Captured at module load -- the one genuinely real setTimeout this file uses as a bounded guard
// against a hanging RED/implementation gap (see the two timeout tests below). Not a fake-timers
// workaround: Node's `AbortSignal.timeout` schedules through an internal timer binding that
// `vi.useFakeTimers()` does not intercept (verified empirically against this repo's Node 24 --
// `vi.advanceTimersByTimeAsync` never fires it), so those two tests spy on `AbortSignal.timeout`
// itself instead of faking the clock.
const REAL_SET_TIMEOUT = globalThis.setTimeout.bind(globalThis);

function jsonResponse(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("apiGet/apiSend", () => {
  // Explicitly instantiated with `typeof fetch` (rather than the bare `ReturnType<typeof vi.fn>`
  // this file used before) -- an uninstantiated generic `Mock<Procedure>` resolves `T` to its
  // full constraint (`Procedure | Constructable`), which makes `mockImplementationOnce`'s
  // parameter type a union that includes a `void`-returning construct-signature member and trips
  // `@typescript-eslint/no-misused-promises` on any Promise-returning implementation passed to
  // it. Binding `T` concretely to `typeof fetch` removes that union and is also strictly more
  // accurate for every existing `mockResolvedValueOnce`/`mockRejectedValueOnce` call below.
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves a 200 JSON response to { ok: true, data } with the body unchanged", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { id: "srv_1", name: "db-1" }),
    );

    const result = await apiGet<{ id: string; name: string }>(
      "/api/servers/srv_1",
    );

    expect(result).toEqual({ ok: true, data: { id: "srv_1", name: "db-1" } });
  });

  it("parses a 400 VALIDATION_FAILED body, preserving issues", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, {
        error: "VALIDATION_FAILED",
        message: "Request does not match the schema",
        issues: [
          { path: "sshPort", message: "Port must be between 1 and 65535" },
        ],
      }),
    );

    const result = await apiSend("POST", "/api/servers", { sshPort: 99999 });

    expect(result).toEqual({
      ok: false,
      code: "VALIDATION_FAILED",
      message: "Request does not match the schema",
      issues: [
        { path: "sshPort", message: "Port must be between 1 and 65535" },
      ],
      unauthorized: false,
    });
  });

  it("parses a 404 NOT_FOUND body with issues absent", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(404, {
        error: "NOT_FOUND",
        message: "This server no longer exists.",
      }),
    );

    const result = await apiGet("/api/servers/missing");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("NOT_FOUND");
    expect(result.message).toBe("This server no longer exists.");
    expect(result.issues).toBeUndefined();
  });

  it("resolves a 401 to a failure with code UNAUTHORIZED and sets unauthorized: true", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, {
        error: "UNAUTHORIZED",
        message: "Not authenticated",
      }),
    );

    const result = await apiGet("/api/servers");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("UNAUTHORIZED");
    expect(result.unauthorized).toBe(true);
  });

  it("parses a Retry-After header into retryAfterSeconds on a 503", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        503,
        { error: "QUEUE_UNAVAILABLE", message: "Try again shortly" },
        { "Retry-After": "5" },
      ),
    );

    const result = await apiSend("POST", "/api/servers/srv_1/connect");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("QUEUE_UNAVAILABLE");
    expect(result.retryAfterSeconds).toBe(5);
  });

  it("degrades a non-JSON or empty error body to a generic INTERNAL_ERROR, never the raw text", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("<html>502 Bad Gateway</html>", { status: 502 }),
    );

    const result = await apiGet("/api/servers");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INTERNAL_ERROR");
    expect(result.message).not.toContain("html");
    expect(result.message).not.toContain("Bad Gateway");
  });

  // Gap 6 / T-5G-31-02: before this plan, a real 409 FINGERPRINT_MISMATCH/SERVER_NOT_TRUSTABLE body
  // parsed to INTERNAL_ERROR -- neither code was in `KNOWN_SERVICE_ERROR_CODES` yet. This is the RED
  // case that must fail against the pre-Task-1 code and pass after it.
  it("parses a 409 FINGERPRINT_MISMATCH body to its own code, never degrading to INTERNAL_ERROR", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(409, {
        error: "FINGERPRINT_MISMATCH",
        message:
          "Submitted fingerprint no longer matches the server’s pending fingerprint",
      }),
    );

    const result = await apiSend(
      "POST",
      "/api/servers/srv_1/trust-fingerprint",
      { fingerprint: "SHA256:abc" },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("FINGERPRINT_MISMATCH");
  });

  it("parses a 409 SERVER_NOT_TRUSTABLE body to its own code, never degrading to INTERNAL_ERROR", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(409, {
        error: "SERVER_NOT_TRUSTABLE",
        message: "Server is not in a state that can trust a fingerprint",
      }),
    );

    const result = await apiSend(
      "POST",
      "/api/servers/srv_1/trust-fingerprint",
      { fingerprint: "SHA256:abc" },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("SERVER_NOT_TRUSTABLE");
  });

  // T-5G-31-02: the drift guard. `ALL_KNOWN_SERVICE_ERROR_CODES` is derived from the same
  // exhaustiveness-checked marker `isKnownServiceErrorCode` reads at runtime (see api-client.ts) --
  // this proves every member of `ApiErrorCode` (minus NETWORK_ERROR) really is recognised as a known
  // code end to end, through the public apiGet/apiSend surface, not just by inspecting the list.
  it("recognises every ApiErrorCode (except NETWORK_ERROR) as a known service error code", async () => {
    for (const code of ALL_KNOWN_SERVICE_ERROR_CODES) {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(409, { error: code, message: "x" }),
      );
      const result = await apiGet("/api/servers/srv_1");
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.code).toBe(code);
    }
  });

  // 09-10-PLAN.md Task 1: the four new account/session codes (09-06/09-08/09-09's backend) must
  // parse to their own code, never degrading to INTERNAL_ERROR -- the same drift class Gap 6 fixed
  // for FINGERPRINT_MISMATCH/SERVER_NOT_TRUSTABLE above.
  it("parses the four new account/session error codes to their own code, never degrading to INTERNAL_ERROR", async () => {
    const cases: readonly [code: string, status: number][] = [
      ["EMAIL_DOMAIN_UNRESOLVABLE", 400],
      ["EMAIL_DOMAIN_CHECK_UNAVAILABLE", 503],
      ["REAUTH_LOCKED", 429],
      ["SESSION_REVOKED_PASSWORD_CHANGED", 401],
    ];

    for (const [code, status] of cases) {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(status, { error: code, message: "x" }),
      );
      const result = await apiGet("/api/account/profile");
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.code).toBe(code);
    }
  });

  it("issues every request with credentials: same-origin and a relative /api/ URL", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    await apiGet("/api/servers");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/servers",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("throws before calling fetch when given an absolute URL, never a relative /api/ path", async () => {
    await expect(
      apiGet("https://evil.example.com/api/servers"),
    ).rejects.toThrow();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves a rejected fetch to a NETWORK_ERROR failure without echoing the thrown message", async () => {
    fetchMock.mockRejectedValueOnce(
      new TypeError("internal-dns-resolver-hostname-leak"),
    );

    const result = await apiGet("/api/servers");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("NETWORK_ERROR");
    expect(result.message).not.toContain("internal-dns-resolver-hostname-leak");
  });

  // T-5G-28-01 (05-28-PLAN.md): a hung peer must never hang the fetch indefinitely. Rather than
  // waiting out a real 15s timeout (or fighting fake timers -- `AbortSignal.timeout` does not
  // respect `vi.useFakeTimers()`, verified empirically), both tests spy on `AbortSignal.timeout`
  // itself and drive an `AbortController` the test owns directly, simulating "the budget elapsed"
  // deterministically and instantly. Every awaited result is still raced against a *real* setTimeout
  // guard so a genuine implementation gap fails fast with an assertion, never an indefinite hang.
  async function raceAgainstRealGuard<T>(
    promise: Promise<T>,
    guardMs = 2000,
  ): Promise<T | "timed-out"> {
    const guard = new Promise<"timed-out">((resolve) => {
      REAL_SET_TIMEOUT(() => {
        resolve("timed-out");
      }, guardMs);
    });
    return Promise.race([promise, guard]);
  }

  /** A fetch stand-in matching real `fetch`'s own documented abort contract: it never settles on
   *  its own (the peer genuinely hung), but rejects with an `AbortError` the instant whatever
   *  signal it was called with aborts -- exactly what the real Fetch spec (and Node's undici
   *  implementation) does. A mock that ignored `init.signal` entirely would let a real
   *  implementation gap hang this test forever instead of failing it. */
  function hungFetchHonoringAbort(
    _input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    });
  }

  it("resolves a never-settling fetch to NETWORK_ERROR once the request timeout budget elapses, never hanging", async () => {
    const timeoutController = new AbortController();
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(timeoutController.signal);
    try {
      fetchMock.mockImplementationOnce(hungFetchHonoringAbort);

      const resultPromise = apiGet("/api/servers");
      timeoutController.abort(); // simulates the request-timeout budget elapsing

      const outcome = await raceAgainstRealGuard(resultPromise);

      expect(outcome).not.toBe("timed-out");
      expect(outcome).toEqual({
        ok: false,
        code: "NETWORK_ERROR",
        message:
          "Could not reach the server. Check your connection and try again.",
        unauthorized: false,
      });
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("passes fetch a signal that the request-timeout budget can abort", async () => {
    const timeoutController = new AbortController();
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(timeoutController.signal);
    try {
      let capturedSignal: AbortSignal | undefined;
      fetchMock.mockImplementationOnce(
        (input: string | URL | Request, init?: RequestInit) => {
          capturedSignal = init?.signal ?? undefined;
          return hungFetchHonoringAbort(input, init);
        },
      );

      const resultPromise = apiGet("/api/servers");
      timeoutController.abort();
      await raceAgainstRealGuard(resultPromise);

      expect(capturedSignal).toBeDefined();
      expect(capturedSignal?.aborted).toBe(true);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("bounds the request timeout to the single exported API_REQUEST_TIMEOUT_MS budget for both apiGet and apiSend", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    try {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
      await apiGet("/api/servers");
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
      await apiSend("POST", "/api/servers/srv_1/connect");

      expect(timeoutSpy).toHaveBeenCalledWith(API_REQUEST_TIMEOUT_MS);
      expect(
        timeoutSpy.mock.calls.every(([ms]) => ms === API_REQUEST_TIMEOUT_MS),
      ).toBe(true);
    } finally {
      timeoutSpy.mockRestore();
    }
  });
});

// 13-05: the deploy-engine vocabulary, the caller signal, sensitive bodies (H1) and 401 handling (H2).
describe("apiGet/apiSend 13-05 additions", () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("covers every server error code between the core and deploy-engine lists, with no overlap", () => {
    expectTypeOf<
      Exclude<DeployApiErrorCode, "NETWORK_ERROR">
    >().toEqualTypeOf<ServiceErrorCode>();
    const core = new Set<string>(ALL_KNOWN_SERVICE_ERROR_CODES);
    expect(
      ALL_DEPLOY_ENGINE_ERROR_CODES.filter((code) => core.has(code)),
    ).toEqual([]);
  });

  it("folds a deploy-engine code to INTERNAL_ERROR on the core calls, keeps it on the deploy calls", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(409, { error: "DEPLOYMENT_IN_PROGRESS", message: "Busy." }),
    );
    const core = await apiSend("POST", "/api/services/s/deploy", {});
    fetchMock.mockResolvedValueOnce(
      jsonResponse(409, { error: "DEPLOYMENT_IN_PROGRESS", message: "Busy." }),
    );
    const deploy = await deployApiSend("POST", "/api/services/s/deploy", {});

    expect(core).toMatchObject({ ok: false, code: "INTERNAL_ERROR" });
    expect(deploy).toMatchObject({ ok: false, code: "DEPLOYMENT_IN_PROGRESS" });
  });

  it("resolves a 401 without a recognised body to UNAUTHORIZED, fetching once", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("gateway says no", { status: 401 }),
    );

    const result = await deployApiGet("/api/projects");

    expect(result).toMatchObject({
      ok: false,
      code: "UNAUTHORIZED",
      unauthorized: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts the request when the caller signal aborts, composed with the timeout", async () => {
    const caller = new AbortController();
    fetchMock.mockImplementationOnce(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );

    const pending = deployApiGet("/api/projects", { signal: caller.signal });
    caller.abort();

    await expect(pending).resolves.toMatchObject({
      ok: false,
      code: "NETWORK_ERROR",
    });
  });

  it("scrubs every echo of a sensitive body from the failure, and leaves other calls untouched", async () => {
    const secret = "tok-canary-77aa";
    const echo = {
      error: "VALIDATION_FAILED",
      message: `bad value ${secret}`,
      issues: [{ path: "token", message: `value ${secret} rejected` }],
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(400, echo));
    const sensitive = await apiSend(
      "PUT",
      "/api/x",
      { token: secret },
      { sensitive: true },
    );
    fetchMock.mockResolvedValueOnce(jsonResponse(400, echo));
    const plain = await apiSend("PUT", "/api/x", { name: "not-a-secret" });

    expect(JSON.stringify(sensitive)).not.toContain(secret);
    expect(sensitive).toMatchObject({
      ok: false,
      code: "VALIDATION_FAILED",
      issues: [{ path: "token", message: "This value is not valid." }],
    });
    expect(plain).toMatchObject({ ok: false, message: `bad value ${secret}` });
  });

  it("resolves an unserialisable body to INTERNAL_ERROR without fetching", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    const result = await apiSend("POST", "/api/x", cyclic);

    expect(result).toMatchObject({ ok: false, code: "INTERNAL_ERROR" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
