import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import parseSetCookie from "set-cookie-parser";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { revealSecret } from "@noodara/domain/security";
import { activityEvents } from "../../../apps/control-plane/src/db/schema/activity-events.js";
import { environments } from "../../../apps/control-plane/src/db/schema/environments.js";
import { servers } from "../../../apps/control-plane/src/db/schema/servers.js";
import { services } from "../../../apps/control-plane/src/db/schema/services.js";
import { issueToken } from "../../../apps/control-plane/src/services/setup-token-repository.js";
import { startTestApp, type TestAppFixture } from "../helpers/app.js";

// 13-01: `DELETE /api/projects/:projectId/environments/:environmentId` against the real HTTP
// surface and a migrated Postgres. The race tests hold a real row lock in a test transaction and
// wait until the request is provably blocked on it before releasing, so each interleaving is
// forced rather than hoped for.

const ADMIN_EMAIL = "admin@noodara.test";
const ADMIN_PASSWORD = "correct horse battery staple";
const FOREIGN_ORIGIN = "https://evil.example";
const LOCK_WAIT_TIMEOUT_MS = 5_000;

let fixture: TestAppFixture;
let cookie: string;

type Json = Record<string, unknown>;
type InjectResponse = Awaited<ReturnType<TestAppFixture["app"]["inject"]>>;

function short(): string {
  return randomUUID().replace(/-/g, "").slice(0, 10);
}

function cookieHeaderFrom(response: {
  headers: Record<string, unknown>;
}): string {
  const raw = response.headers["set-cookie"];
  const rawCookies = Array.isArray(raw)
    ? raw
    : raw !== undefined
      ? [String(raw)]
      : [];
  return parseSetCookie
    .parse(rawCookies, { map: false })
    .map((entry) => `${entry.name}=${entry.value}`)
    .join("; ");
}

async function signIn(): Promise<string> {
  const issued = await issueToken(fixture.db, "setup", new Date());
  const setup = await fixture.app.inject({
    method: "POST",
    url: "/api/setup",
    payload: {
      token: revealSecret(issued.token),
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      name: "Admin",
    },
  });
  if (setup.statusCode !== 200)
    throw new Error(`setup failed: ${setup.statusCode.toString()}`);
  const response = await fixture.app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  if (response.statusCode !== 200)
    throw new Error(`sign-in failed: ${response.statusCode.toString()}`);
  return cookieHeaderFrom(response);
}

function send(
  method: "GET" | "POST" | "DELETE",
  url: string,
  payload?: Json,
): Promise<InjectResponse> {
  return fixture.app.inject({
    method,
    url,
    headers: { cookie },
    ...(payload !== undefined ? { payload } : {}),
  });
}

async function call(
  method: "GET" | "POST" | "DELETE",
  url: string,
  payload?: Json,
): Promise<{ statusCode: number; body: Json }> {
  const response = await send(method, url, payload);
  return { statusCode: response.statusCode, body: response.json() as Json };
}

async function newProject(): Promise<string> {
  const project = await call("POST", "/api/projects", {
    name: `Env Delete ${short()}`,
  });
  expect(project.statusCode, JSON.stringify(project.body)).toBe(201);
  return String(project.body.id);
}

async function newEnvironment(
  projectId: string,
  name = "staging",
): Promise<string> {
  const environment = await call(
    "POST",
    `/api/projects/${projectId}/environments`,
    { name },
  );
  expect(environment.statusCode, JSON.stringify(environment.body)).toBe(201);
  return String(environment.body.id);
}

async function newConnectedServer(): Promise<string> {
  const response = await call("POST", "/api/servers", {
    name: `srv-${short()}`,
    host: `${short()}.example.test`,
    credential: { type: "ssh_password", password: "not-used-by-this-test" },
  });
  expect(response.statusCode, JSON.stringify(response.body)).toBe(201);
  const serverId = String(response.body.id);
  await fixture.db
    .update(servers)
    .set({
      status: "CONNECTED",
      dockerInstalled: true,
      dockerBuildkitAvailable: true,
    })
    .where(eq(servers.id, serverId));
  return serverId;
}

function serviceBody(environmentId: string, serverId: string): Json {
  return {
    environmentId,
    name: `web-${short()}`,
    serverId,
    source: { kind: "image", imageRef: "nginx:1.27" },
    internalPort: 80,
  };
}

function environmentUrl(projectId: string, environmentId: string): string {
  return `/api/projects/${projectId}/environments/${environmentId}`;
}

async function environmentExists(environmentId: string): Promise<boolean> {
  const rows = await fixture.db
    .select({ id: environments.id })
    .from(environments)
    .where(eq(environments.id, environmentId));
  return rows.length === 1;
}

async function servicesIn(environmentId: string): Promise<string[]> {
  const rows = await fixture.db
    .select({ id: services.id })
    .from(services)
    .where(eq(services.environmentId, environmentId));
  return rows.map((row) => row.id);
}

async function deletedEvents(
  environmentId: string,
): Promise<{ metadata: unknown }[]> {
  return fixture.db
    .select({ metadata: activityEvents.metadata })
    .from(activityEvents)
    .where(
      and(
        eq(activityEvents.entityId, environmentId),
        eq(activityEvents.action, "environment.deleted"),
      ),
    );
}

/** Resolves once some backend is waiting on a lock it was not granted (the request is blocked). */
async function waitForBlockedLock(): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await fixture.db.execute(
      sql`select count(*)::int as waiting from pg_locks where not granted`,
    );
    const [row] = result.rows as { waiting: number }[];
    if ((row?.waiting ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("the request never blocked on the held row lock");
}

beforeAll(async () => {
  fixture = await startTestApp();
  cookie = await signIn();
});

afterAll(async () => {
  await fixture.stop();
});

describe("environment delete (A1, A2)", () => {
  it("deletes an empty environment by its exact name and writes environment.deleted", async () => {
    const projectId = await newProject();
    const environmentId = await newEnvironment(projectId, "preview");
    const keptId = await newEnvironment(projectId, "production");

    const deleted = await call(
      "DELETE",
      environmentUrl(projectId, environmentId),
      { confirmName: "preview" },
    );
    expect(deleted.statusCode, JSON.stringify(deleted.body)).toBe(200);
    expect(deleted.body).toStrictEqual({ ok: true, environmentId });

    expect(await environmentExists(environmentId)).toBe(false);
    expect(await environmentExists(keptId)).toBe(true);
    expect(await deletedEvents(environmentId)).toStrictEqual([
      { metadata: { projectId, name: "preview" } },
    ]);
    const listed = await call("GET", `/api/projects/${projectId}/environments`);
    expect((listed.body.items as Json[]).map((item) => item.id)).toStrictEqual([
      keptId,
    ]);

    const again = await call(
      "DELETE",
      environmentUrl(projectId, environmentId),
      { confirmName: "preview" },
    );
    expect(again.statusCode).toBe(404);
  });

  it("rejects a name that is not exactly the environment name with 422 and changes nothing", async () => {
    const projectId = await newProject();
    const environmentId = await newEnvironment(projectId, "staging");

    for (const confirmName of [
      "",
      "Staging",
      " staging",
      "staging ",
      "stagin",
    ]) {
      const response = await call(
        "DELETE",
        environmentUrl(projectId, environmentId),
        { confirmName },
      );
      expect(response.statusCode, confirmName).toBe(422);
      expect(response.body).toStrictEqual({
        error: "DELETE_CONFIRMATION_MISMATCH",
        message: expect.any(String),
      });
    }
    expect(await environmentExists(environmentId)).toBe(true);
    expect(await deletedEvents(environmentId)).toHaveLength(0);
  });

  it("refuses an environment that still has services with 409 ENVIRONMENT_NOT_EMPTY and changes nothing", async () => {
    const projectId = await newProject();
    const environmentId = await newEnvironment(projectId, "production");
    const serverId = await newConnectedServer();
    const created = await call(
      "POST",
      `/api/projects/${projectId}/services`,
      serviceBody(environmentId, serverId),
    );
    expect(created.statusCode, JSON.stringify(created.body)).toBe(201);

    const response = await call(
      "DELETE",
      environmentUrl(projectId, environmentId),
      { confirmName: "production" },
    );
    expect(response.statusCode).toBe(409);
    expect(response.body).toStrictEqual({
      error: "ENVIRONMENT_NOT_EMPTY",
      message: expect.any(String),
    });
    expect(await environmentExists(environmentId)).toBe(true);
    expect(await servicesIn(environmentId)).toStrictEqual([
      String(created.body.id),
    ]);
    expect(await deletedEvents(environmentId)).toHaveLength(0);
  });

  it("answers another project's environment exactly like an unknown one, even with the right name (H2)", async () => {
    const ownerId = await newProject();
    const environmentId = await newEnvironment(ownerId, "production");
    const otherId = await newProject();

    const foreign = await call(
      "DELETE",
      environmentUrl(otherId, environmentId),
      { confirmName: "production" },
    );
    const foreignWrongName = await call(
      "DELETE",
      environmentUrl(otherId, environmentId),
      { confirmName: "nope" },
    );
    const unknownProject = await call(
      "DELETE",
      environmentUrl(randomUUID(), environmentId),
      { confirmName: "production" },
    );
    expect(foreign.statusCode).toBe(404);
    expect(foreignWrongName.statusCode).toBe(404);
    expect(unknownProject.statusCode).toBe(404);
    expect(foreignWrongName.body).toStrictEqual(foreign.body);
    expect(unknownProject.body).toStrictEqual(foreign.body);

    const unknownId = randomUUID();
    const unknown = await call("DELETE", environmentUrl(otherId, unknownId), {
      confirmName: "production",
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.body).toStrictEqual({
      error: "NOT_FOUND",
      message: String(foreign.body.message).replace(environmentId, unknownId),
    });
    expect(await environmentExists(environmentId)).toBe(true);
  });
});

describe("environment delete hostile input and guards (H2)", () => {
  it("maps malformed JSON, a missing or unknown field and an oversized body to 4xx and keeps serving", async () => {
    const projectId = await newProject();
    const environmentId = await newEnvironment(projectId, "staging");
    const url = environmentUrl(projectId, environmentId);
    const canary = "CANARY-BODY-NEVER-ECHOED";

    const malformed = await fixture.app.inject({
      method: "DELETE",
      url,
      headers: { cookie, "content-type": "application/json" },
      payload: `{"confirmName": "${canary}"`,
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toStrictEqual({
      error: "MALFORMED_REQUEST",
      message: expect.any(String),
    });
    expect(malformed.body).not.toContain(canary);

    const noBody = await fixture.app.inject({
      method: "DELETE",
      url,
      headers: { cookie },
    });
    expect(noBody.statusCode).toBe(400);

    const missing = await call("DELETE", url, {});
    expect(missing.statusCode).toBe(400);
    expect(missing.body.error).toBe("VALIDATION_FAILED");

    const wrongField = await call("DELETE", url, { name: "staging" });
    expect(wrongField.statusCode).toBe(400);

    const unknownField = await call("DELETE", url, {
      confirmName: "staging",
      cascade: true,
    });
    expect(unknownField.statusCode).toBe(400);
    expect(unknownField.body.error).toBe("VALIDATION_FAILED");

    const oversized = await call("DELETE", url, {
      confirmName: "x".repeat(32 * 1024),
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.body).toStrictEqual({
      error: "PAYLOAD_TOO_LARGE",
      message: expect.any(String),
    });

    const malformedId = await call(
      "DELETE",
      environmentUrl(projectId, "staging"),
      { confirmName: "staging" },
    );
    expect(malformedId.statusCode).toBe(400);

    expect(await environmentExists(environmentId)).toBe(true);
    expect((await call("GET", "/api/projects")).statusCode).toBe(200);
  });

  it("requires a session: the same 401 for an existing and an unknown environment", async () => {
    const projectId = await newProject();
    const environmentId = await newEnvironment(projectId, "staging");
    const existing = await fixture.app.inject({
      method: "DELETE",
      url: environmentUrl(projectId, environmentId),
      payload: { confirmName: "staging" },
    });
    const unknown = await fixture.app.inject({
      method: "DELETE",
      url: environmentUrl(randomUUID(), randomUUID()),
      payload: { confirmName: "staging" },
    });
    expect(existing.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(unknown.body).toBe(existing.body);
    expect(await environmentExists(environmentId)).toBe(true);
  });

  it("rejects a cross-origin delete with 403 before it touches anything", async () => {
    const projectId = await newProject();
    const environmentId = await newEnvironment(projectId, "staging");
    const response = await fixture.app.inject({
      method: "DELETE",
      url: environmentUrl(projectId, environmentId),
      headers: { cookie, origin: FOREIGN_ORIGIN },
      payload: { confirmName: "staging" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "FORBIDDEN_ORIGIN" });
    expect(await environmentExists(environmentId)).toBe(true);
    expect(await deletedEvents(environmentId)).toHaveLength(0);
  });
});

describe("environment delete races a service create (H1)", () => {
  it("a delete arriving while a service insert is uncommitted waits for it and answers 409", async () => {
    const projectId = await newProject();
    const environmentId = await newEnvironment(projectId, "production");
    const serverId = await newConnectedServer();

    let pending: Promise<InjectResponse> | undefined;
    await fixture.db.transaction(async (tx) => {
      await tx.insert(services).values({
        projectId,
        environmentId,
        serverId,
        name: "web",
        sourceType: "image",
        imageRef: "nginx:1.27",
        internalPort: 80,
      });
      pending = send("DELETE", environmentUrl(projectId, environmentId), {
        confirmName: "production",
      });
      await waitForBlockedLock();
    });
    const response = await (pending ??
      Promise.reject(new Error("delete was never sent")));

    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toStrictEqual({
      error: "ENVIRONMENT_NOT_EMPTY",
      message: expect.any(String),
    });
    expect(await environmentExists(environmentId)).toBe(true);
    expect(await servicesIn(environmentId)).toHaveLength(1);
  });

  it("a service create arriving while the environment delete is uncommitted waits for it and answers 404", async () => {
    const projectId = await newProject();
    const environmentId = await newEnvironment(projectId, "production");
    const serverId = await newConnectedServer();

    let pending: Promise<InjectResponse> | undefined;
    await fixture.db.transaction(async (tx) => {
      await tx
        .select()
        .from(environments)
        .where(eq(environments.id, environmentId))
        .for("update");
      await tx.delete(environments).where(eq(environments.id, environmentId));
      pending = send(
        "POST",
        `/api/projects/${projectId}/services`,
        serviceBody(environmentId, serverId),
      );
      await waitForBlockedLock();
    });
    const response = await (pending ??
      Promise.reject(new Error("create was never sent")));

    expect(response.statusCode, response.body).toBe(404);
    expect(response.json()).toStrictEqual({
      error: "NOT_FOUND",
      message: expect.any(String),
    });
    expect(await servicesIn(environmentId)).toHaveLength(0);
  });

  it("concurrent delete and create always settle as (200, 404) or (409, 201), never a 500 or an orphan", async () => {
    const projectId = await newProject();
    const serverId = await newConnectedServer();

    for (let round = 0; round < 8; round += 1) {
      const name = `race-${round.toString()}`;
      const environmentId = await newEnvironment(projectId, name);
      const [deleted, created] = await Promise.all([
        send("DELETE", environmentUrl(projectId, environmentId), {
          confirmName: name,
        }),
        send(
          "POST",
          `/api/projects/${projectId}/services`,
          serviceBody(environmentId, serverId),
        ),
      ]);
      const outcome = `${deleted.statusCode.toString()}/${created.statusCode.toString()}`;
      expect(
        ["200/404", "409/201"],
        `${outcome} ${deleted.body} ${created.body}`,
      ).toContain(outcome);

      const remaining = await servicesIn(environmentId);
      if (deleted.statusCode === 200) {
        expect(await environmentExists(environmentId)).toBe(false);
        expect(remaining).toHaveLength(0);
      } else {
        expect(await environmentExists(environmentId)).toBe(true);
        expect(remaining).toStrictEqual([String((created.json() as Json).id)]);
        await fixture.db
          .delete(services)
          .where(eq(services.environmentId, environmentId));
      }
    }
  });
});
