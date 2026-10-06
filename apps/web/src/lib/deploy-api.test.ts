// 13-05: deploy-api.ts route table, the deploy-engine error vocabulary, write-only credentials
// (A2/H1 canary), session-expired handling and no-retry (H2), and explicit timeouts (A4).
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";
import { API_REQUEST_TIMEOUT_MS } from "./api-client";
import {
  archiveProject,
  cancelDeployment,
  createEnvironment,
  createProject,
  createService,
  deleteEnvironment,
  deleteProject,
  deleteService,
  deployService,
  getDeployment,
  getDeploymentLogs,
  getEnvironment,
  getProject,
  getRuntimeLogs,
  getService,
  getServiceCredentials,
  getServiceDeployment,
  listDeployments,
  listEnvironments,
  listProjects,
  listServices,
  redeployService,
  removeServiceCredential,
  runServiceOperation,
  runtimeLogFollowPath,
  setRegistryCredential,
  setRepositoryCredential,
  unarchiveProject,
  updateEnvironment,
  updateProject,
  updateService,
  type CredentialSlot,
  type DeployApiResult,
  type DeploymentView,
  type EnvironmentView,
  type ProjectView,
  type RuntimeLogLine,
  type ServiceCredentials,
  type ServiceOperation,
  type ServiceView,
} from "./deploy-api";

const P = "11111111-1111-4111-8111-111111111111";
const E = "22222222-2222-4222-8222-222222222222";
const S = "33333333-3333-4333-8333-333333333333";
const D = "44444444-4444-4444-8444-444444444444";

const REAL_SET_TIMEOUT = globalThis.setTimeout.bind(globalThis);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function bodyOf(init: RequestInit): unknown {
  return typeof init.body === "string"
    ? (JSON.parse(init.body) as unknown)
    : init.body;
}

interface CallRecorder {
  readonly mock: { readonly calls: readonly unknown[] };
}

function lastInit(): RequestInit {
  const call = fetchMock.mock.calls.at(-1);
  if (call === undefined) throw new Error("fetch was not called");
  return call[1] ?? {};
}

function lastPath(): string {
  const call = fetchMock.mock.calls.at(-1);
  if (call === undefined) throw new Error("fetch was not called");
  return urlOf(call[0]);
}

describe("types come from the control-plane schemas (A1)", () => {
  it("infers views, not never, with the server field types", () => {
    expectTypeOf<ProjectView>().not.toBeNever();
    expectTypeOf<ProjectView["id"]>().toEqualTypeOf<string>();
    expectTypeOf<EnvironmentView["projectId"]>().toEqualTypeOf<string>();
    expectTypeOf<ServiceView["sourceType"]>().toEqualTypeOf<"git" | "image">();
    expectTypeOf<ServiceView["publishedPort"]>().toEqualTypeOf<number | null>();
    expectTypeOf<DeploymentView["durationMs"]>().toEqualTypeOf<number | null>();
    expectTypeOf<RuntimeLogLine["stream"]>().toEqualTypeOf<
      "stdout" | "stderr"
    >();
    expectTypeOf<ServiceOperation>().toEqualTypeOf<
      "stop" | "restart" | "remove"
    >();
    expectTypeOf<CredentialSlot>().toEqualTypeOf<"repository" | "registry">();
  });

  it("has no credential type that can carry a secret value back (A2)", () => {
    expectTypeOf<keyof ServiceCredentials>().toEqualTypeOf<
      "repository" | "registry"
    >();
    expectTypeOf<
      keyof NonNullable<ServiceCredentials["repository"]>
    >().toEqualTypeOf<"type" | "publicKey">();
    expectTypeOf<
      keyof NonNullable<ServiceCredentials["registry"]>
    >().toEqualTypeOf<"type" | "publicKey">();
    expectTypeOf(setRegistryCredential).returns.toEqualTypeOf<
      Promise<DeployApiResult<ServiceCredentials>>
    >();
    expectTypeOf(setRepositoryCredential).returns.toEqualTypeOf<
      Promise<DeployApiResult<ServiceCredentials>>
    >();
  });
});

describe("route table (docs/deploy-engine.md)", () => {
  const cases: readonly (readonly [
    string,
    () => Promise<unknown>,
    string,
    string,
    unknown,
  ])[] = [
    ["listProjects", () => listProjects(), "GET", "/api/projects", undefined],
    ["getProject", () => getProject(P), "GET", `/api/projects/${P}`, undefined],
    [
      "createProject",
      () => createProject({ name: "shop" }),
      "POST",
      "/api/projects",
      { name: "shop" },
    ],
    [
      "updateProject",
      () => updateProject(P, { name: "shop-2" }),
      "PATCH",
      `/api/projects/${P}`,
      { name: "shop-2" },
    ],
    [
      "archiveProject",
      () => archiveProject(P),
      "POST",
      `/api/projects/${P}/archive`,
      {},
    ],
    [
      "unarchiveProject",
      () => unarchiveProject(P),
      "POST",
      `/api/projects/${P}/unarchive`,
      {},
    ],
    [
      "deleteProject",
      () => deleteProject(P, "shop"),
      "DELETE",
      `/api/projects/${P}`,
      { confirmName: "shop" },
    ],
    [
      "listEnvironments",
      () => listEnvironments(P),
      "GET",
      `/api/projects/${P}/environments`,
      undefined,
    ],
    [
      "getEnvironment",
      () => getEnvironment(P, E),
      "GET",
      `/api/projects/${P}/environments/${E}`,
      undefined,
    ],
    [
      "createEnvironment",
      () => createEnvironment(P, { name: "staging" }),
      "POST",
      `/api/projects/${P}/environments`,
      { name: "staging" },
    ],
    [
      "updateEnvironment",
      () => updateEnvironment(P, E, { name: "prod" }),
      "PATCH",
      `/api/projects/${P}/environments/${E}`,
      { name: "prod" },
    ],
    [
      "deleteEnvironment",
      () => deleteEnvironment(P, E, "prod"),
      "DELETE",
      `/api/projects/${P}/environments/${E}`,
      { confirmName: "prod" },
    ],
    [
      "listServices",
      () => listServices(P),
      "GET",
      `/api/projects/${P}/services`,
      undefined,
    ],
    [
      "getService",
      () => getService(P, S),
      "GET",
      `/api/projects/${P}/services/${S}`,
      undefined,
    ],
    [
      "createService",
      () => createService(P, { environmentId: E, name: "api" }),
      "POST",
      `/api/projects/${P}/services`,
      { environmentId: E, name: "api" },
    ],
    [
      "updateService",
      () => updateService(P, S, { branch: "main" }),
      "PATCH",
      `/api/projects/${P}/services/${S}`,
      { branch: "main" },
    ],
    [
      "deleteService",
      () => deleteService(P, S, "api"),
      "DELETE",
      `/api/projects/${P}/services/${S}`,
      { confirmName: "api" },
    ],
    [
      "stop",
      () => runServiceOperation(P, S, "stop"),
      "POST",
      `/api/projects/${P}/services/${S}/stop`,
      {},
    ],
    [
      "restart",
      () => runServiceOperation(P, S, "restart"),
      "POST",
      `/api/projects/${P}/services/${S}/restart`,
      {},
    ],
    [
      "remove",
      () => runServiceOperation(P, S, "remove"),
      "POST",
      `/api/projects/${P}/services/${S}/remove`,
      {},
    ],
    [
      "redeployService",
      () => redeployService(P, S),
      "POST",
      `/api/projects/${P}/services/${S}/redeploy`,
      {},
    ],
    [
      "getServiceCredentials",
      () => getServiceCredentials(P, S),
      "GET",
      `/api/projects/${P}/services/${S}/credentials`,
      undefined,
    ],
    [
      "removeServiceCredential",
      () => removeServiceCredential(P, S, "registry"),
      "DELETE",
      `/api/projects/${P}/services/${S}/credentials/registry`,
      {},
    ],
    [
      "deployService",
      () => deployService(S),
      "POST",
      `/api/services/${S}/deploy`,
      {},
    ],
    [
      "listDeployments",
      () => listDeployments(S),
      "GET",
      `/api/services/${S}/deployments`,
      undefined,
    ],
    [
      "listDeployments (page)",
      () => listDeployments(S, { limit: 20, cursor: "abc" }),
      "GET",
      `/api/services/${S}/deployments?limit=20&cursor=abc`,
      undefined,
    ],
    [
      "getServiceDeployment",
      () => getServiceDeployment(S, D),
      "GET",
      `/api/services/${S}/deployments/${D}`,
      undefined,
    ],
    [
      "getDeployment",
      () => getDeployment(D),
      "GET",
      `/api/deployments/${D}`,
      undefined,
    ],
    [
      "cancelDeployment",
      () => cancelDeployment(D),
      "POST",
      `/api/deployments/${D}/cancel`,
      {},
    ],
    [
      "getDeploymentLogs",
      () => getDeploymentLogs(D, { phase: "build", since: 12, limit: 50 }),
      "GET",
      `/api/deployments/${D}/logs?phase=build&since=12&limit=50`,
      undefined,
    ],
    [
      "getRuntimeLogs",
      () => getRuntimeLogs(P, S, { tail: 200 }),
      "GET",
      `/api/projects/${P}/services/${S}/logs?tail=200`,
      undefined,
    ],
  ];

  it.each(cases)(
    "%s issues %s to the documented path",
    async (_name, call, method, path, body) => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));

      const result = await call();

      expect(result).toEqual({ ok: true, data: { ok: true } });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(lastPath()).toBe(path);
      const init = lastInit();
      expect(init.method).toBe(method);
      expect(init.credentials).toBe("same-origin");
      if (body === undefined) {
        expect(init.body).toBeUndefined();
      } else {
        expect(bodyOf(init)).toEqual(body);
      }
    },
  );

  it("builds the follow stream path with an optional tail", () => {
    expect(runtimeLogFollowPath(P, S)).toBe(
      `/api/projects/${P}/services/${S}/logs/follow`,
    );
    expect(runtimeLogFollowPath(P, S, 50)).toBe(
      `/api/projects/${P}/services/${S}/logs/follow?tail=50`,
    );
  });

  it.each([
    ["a slash", () => getProject("a/b")],
    ["a traversal", () => getService(P, "..")],
    ["a query", () => deployService(`${S}?x=1`)],
    ["an empty id", () => cancelDeployment("")],
    [
      "an unknown operation",
      () => runServiceOperation(P, S, "exec" as ServiceOperation),
    ],
    [
      "an unknown credential slot",
      () => removeServiceCredential(P, S, "ssh" as CredentialSlot),
    ],
  ])(
    "resolves %s to VALIDATION_FAILED without any request",
    async (_name, call) => {
      const result = await call();

      expect(result).toMatchObject({
        ok: false,
        code: "VALIDATION_FAILED",
        unauthorized: false,
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(runtimeLogFollowPath(P, "../x")).toBeNull();
    },
  );
});

describe("deploy-engine error vocabulary", () => {
  it.each([
    [409, "DEPLOYMENT_IN_PROGRESS"],
    [409, "DEPLOYMENT_NOT_CANCELLABLE"],
    [409, "ENVIRONMENT_NOT_EMPTY"],
    [409, "PROJECT_ARCHIVED"],
    [409, "PORT_IN_USE"],
    [422, "DELETE_CONFIRMATION_MISMATCH"],
    [429, "RUNTIME_LOG_FOLLOW_LIMIT_REACHED"],
    [502, "RUNTIME_LOGS_FAILED"],
    [504, "RUNTIME_LOGS_TIMEOUT"],
    [404, "NOT_FOUND"],
  ])("keeps a %i %s as its own typed code", async (status, code) => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(status, { error: code, message: "Fixed server copy." }),
    );

    const result = await deployService(S);

    expect(result).toEqual({
      ok: false,
      code,
      message: "Fixed server copy.",
      unauthorized: false,
    });
  });

  it("keeps a short validator reason and drops free text", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(422, {
        error: "SERVICE_INPUT_INVALID",
        message: "Invalid port.",
        reason: "port_out_of_range",
      }),
    );
    const kept = await createService(P, { environmentId: E });
    expect(kept).toMatchObject({
      ok: false,
      code: "SERVICE_INPUT_INVALID",
      reason: "port_out_of_range",
    });

    fetchMock.mockResolvedValueOnce(
      jsonResponse(422, {
        error: "SERVICE_INPUT_INVALID",
        message: "Invalid port.",
        reason: "the port you sent was bad",
      }),
    );
    const dropped = await createService(P, { environmentId: E });
    expect(dropped.ok).toBe(false);
    if (dropped.ok) return;
    expect(dropped.reason).toBeUndefined();
  });

  it("folds an unknown code to INTERNAL_ERROR", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(500, { error: "SOMETHING_NEW", message: "raw detail" }),
    );

    const result = await listProjects();

    expect(result).toMatchObject({ ok: false, code: "INTERNAL_ERROR" });
  });
});

describe("write-only credentials (A2, H1)", () => {
  const CANARY = "canary-Secret-9f3b2c7d1e";

  function consoleSpies(): CallRecorder[] {
    return (["log", "info", "warn", "error", "debug", "trace"] as const).map(
      (method) => vi.spyOn(console, method).mockImplementation(() => undefined),
    );
  }

  function expectNoCanaryIn(spies: readonly CallRecorder[]): void {
    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(CANARY);
    }
  }

  it("sends the PUT body exactly once and returns only presence and type", async () => {
    const spies = consoleSpies();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        repository: null,
        registry: { type: "registry_password", publicKey: null },
      }),
    );

    const result = await setRegistryCredential(P, S, {
      username: "bot",
      password: CANARY,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastInit().method).toBe("PUT");
    expect(lastPath()).toBe(
      `/api/projects/${P}/services/${S}/credentials/registry`,
    );
    expect(bodyOf(lastInit())).toEqual({ username: "bot", password: CANARY });
    expect(JSON.stringify(result)).not.toContain(CANARY);
    expectNoCanaryIn(spies);
  });

  it("keeps no copy of the secret for later calls", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { repository: null, registry: null }),
    );
    await setRepositoryCredential(P, S, { kind: "https_token", token: CANARY });

    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { repository: null, registry: null }),
    );
    const read = await getServiceCredentials(P, S);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { repository: null, registry: null }),
    );
    await removeServiceCredential(P, S, "repository");

    expect(JSON.stringify(read)).not.toContain(CANARY);
    for (const [, init] of fetchMock.mock.calls.slice(1)) {
      expect(JSON.stringify(init)).not.toContain(CANARY);
    }
  });

  it("never surfaces a failure body that echoes the submitted secret (canary)", async () => {
    const spies = consoleSpies();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(422, {
        error: "SERVICE_CREDENTIAL_INVALID",
        message: `Token ${CANARY} is not valid`,
        reason: CANARY,
        issues: [{ path: CANARY, message: `got ${CANARY}` }],
      }),
    );

    const result = await setRepositoryCredential(P, S, {
      kind: "https_token",
      token: CANARY,
    });

    expect(result).toMatchObject({
      ok: false,
      code: "SERVICE_CREDENTIAL_INVALID",
      unauthorized: false,
    });
    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expectNoCanaryIn(spies);
  });

  it("keeps fixed failure copy that does not echo the secret", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(422, {
        error: "SERVICE_CREDENTIAL_INVALID",
        message: "The password is too long.",
        reason: "password_too_long",
      }),
    );

    const result = await setRegistryCredential(P, S, {
      username: "bot",
      password: CANARY,
    });

    expect(result).toEqual({
      ok: false,
      code: "SERVICE_CREDENTIAL_INVALID",
      message: "The password is too long.",
      reason: "password_too_long",
      unauthorized: false,
    });
  });

  it("does not echo a rejected fetch message that carries the secret", async () => {
    const spies = consoleSpies();
    fetchMock.mockRejectedValueOnce(new TypeError(`failed to send ${CANARY}`));

    const result = await setRegistryCredential(P, S, {
      username: "bot",
      password: CANARY,
    });

    expect(result).toMatchObject({ ok: false, code: "NETWORK_ERROR" });
    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expectNoCanaryIn(spies);
  });
});

describe("session and retry rules (H2)", () => {
  it("sends mutations same-origin as JSON so the origin guard can check them", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { id: D }));

    await deployService(S);

    const init = lastInit();
    expect(init.credentials).toBe("same-origin");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(lastPath().startsWith("/api/")).toBe(true);
  });

  it.each([
    [
      "a JSON 401",
      () =>
        jsonResponse(401, {
          error: "UNAUTHORIZED",
          message: "Not authenticated",
        }),
    ],
    [
      "a non-JSON 401",
      () => new Response("<html>expired</html>", { status: 401 }),
    ],
    [
      "a 401 with an unknown code",
      () => jsonResponse(401, { error: "SESSION_GONE" }),
    ],
  ])(
    "resolves %s to session-expired once, never retried",
    async (_name, response) => {
      fetchMock.mockResolvedValue(response());

      const results = await Promise.all([
        listProjects(),
        deployService(S),
        cancelDeployment(D),
      ]);

      for (const result of results) {
        expect(result).toMatchObject({
          ok: false,
          code: "UNAUTHORIZED",
          unauthorized: true,
        });
      }
      expect(fetchMock).toHaveBeenCalledTimes(3);
    },
  );

  /** Never settles; rejects with an AbortError once its signal aborts, like real fetch. */
  function hungFetchHonoringAbort(
    _input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("The operation timed out.", "TimeoutError"));
      });
    });
  }

  async function withGuard<T>(promise: Promise<T>): Promise<T | "timed-out"> {
    const guard = new Promise<"timed-out">((resolve) => {
      REAL_SET_TIMEOUT(() => {
        resolve("timed-out");
      }, 2000);
    });
    return Promise.race([promise, guard]);
  }

  it.each([
    ["deploy", () => deployService(S)],
    ["cancel", () => cancelDeployment(D)],
  ])("never retries a timed-out %s POST", async (_name, call) => {
    const timeoutController = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    fetchMock.mockImplementation(hungFetchHonoringAbort);

    const pending = call();
    timeoutController.abort();
    const outcome = await withGuard(pending);

    expect(outcome).toMatchObject({
      ok: false,
      code: "NETWORK_ERROR",
      unauthorized: false,
    });
    await new Promise((resolve) => REAL_SET_TIMEOUT(resolve, 20));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("timeouts and network failures (A4)", () => {
  it("gives every call the shared request timeout", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, {})));

    await listProjects();
    await deployService(S);
    await setRegistryCredential(P, S, {
      username: "bot",
      password: "pw-12345",
    });
    await getRuntimeLogs(P, S);

    expect(timeoutSpy).toHaveBeenCalledTimes(4);
    expect(
      timeoutSpy.mock.calls.every(([ms]) => ms === API_REQUEST_TIMEOUT_MS),
    ).toBe(true);
  });

  it("resolves a rejected fetch to NETWORK_ERROR, never an unhandled rejection", async () => {
    fetchMock.mockRejectedValueOnce(
      new TypeError("getaddrinfo ENOTFOUND internal-host"),
    );

    const result = await listServices(P);

    expect(result).toEqual({
      ok: false,
      code: "NETWORK_ERROR",
      message:
        "Could not reach the server. Check your connection and try again.",
      unauthorized: false,
    });
  });

  it("resolves a body dropped mid-read to NETWORK_ERROR", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"items":['));
        controller.error(new TypeError("terminated"));
      },
    });
    fetchMock.mockResolvedValueOnce(new Response(body, { status: 200 }));

    const result = await listProjects();

    expect(result).toMatchObject({ ok: false, code: "NETWORK_ERROR" });
  });

  it("resolves a 2xx that is not JSON to INTERNAL_ERROR", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("<html>proxy</html>", { status: 200 }),
    );

    const result = await getProject(P);

    expect(result).toMatchObject({ ok: false, code: "INTERNAL_ERROR" });
    if (result.ok) return;
    expect(result.message).not.toContain("proxy");
  });

  it("resolves an empty 2xx body to data undefined", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const result = await archiveProject(P);

    expect(result).toEqual({ ok: true, data: undefined });
  });
});
