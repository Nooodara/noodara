// 22-02 proxy lifecycle on the real sshd + dockerd fixture (gate it-proxy, Ubuntu 24.04).
// The request side (requestProxyInstall, setProxyAcmeEmail, removeServerProxy) runs against a
// migrated Postgres; the captured job payload is handed to the real install job handler wired by
// createProxyInstallJobDeps (the worker's wiring), over the SSH adapter, against Pebble as CA.
//   A1: port 80 held by a foreign process -> FAILED/PROXY_PORT_IN_USE naming it; then install ->
//       RUNNING with the admin's ACME email, activity server.proxy_installed | proxy_failed.
//   A2: re-install on RUNNING is idempotent; PATCH proxyAcmeEmail re-renders the static config.
//   A3: remove answers PROXY_IN_USE (409) while a domain exists; otherwise ends NOT_INSTALLED
//       with no container and no /opt/noodara-proxy.
//   A5/H3: the static config holds the ACME email but no credential; the canary SSH key and the
//       master key never reach the payload, the logs, the activity metadata or the events.
// Root-side truth comes from `stack.exec` as root. App modules are imported dynamically after a
// valid test env is written: activity/redaction.ts imports env.ts, which fail-fasts at import.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROXY_LAYOUT, proxyContainerName } from "@noodara/domain";
import { createRedactor, secretValue } from "@noodara/domain/security";
import {
  createSsh2Adapter,
  formatFingerprint,
  type SshTimeouts,
} from "@noodara/ssh";
import {
  activityEvents,
  credentials,
  domains,
  environments,
  projects,
  servers,
  services,
  users,
} from "../../../apps/control-plane/src/db/schema/index.js";
import type { ServerEvent } from "../../../apps/control-plane/src/events/server-event-publisher.js";
import type {
  ProxyServiceDeps,
  ProxyServiceResult,
} from "../../../apps/control-plane/src/proxy/proxy-service.js";
import type { ProxyInstallJobPayload } from "../../../apps/control-plane/src/queue/proxy-job-payload.js";
import type { ServerView } from "../../../apps/control-plane/src/services/server-view.js";
import {
  DEPLOY_ENGINE_UBUNTU_VERSIONS,
  startDeployEngineStack,
  type DeployEngineStack,
} from "../helpers/deploy-engine.js";
import {
  PEBBLE_ACME_DIRECTORY_URL,
  PEBBLE_HOSTNAME,
  TRAEFIK_IMAGE,
  startPebble,
  type StartedPebble,
} from "../helpers/pebble.js";
import { startPostgres, type PostgresFixture } from "../helpers/postgres.js";
import { expectRemoteMatchesDatabase } from "./remote-state-probe.js";
import { assertNoStrayTestContainers } from "../helpers/ssh.js";

const STACK_TIMEOUT_MS = 900_000;
/** Above the install budget (600 s, a cold Traefik pull included). */
const INSTALL_CASE_TIMEOUT_MS = 720_000;
const CASE_TIMEOUT_MS = 180_000;
const TIMEOUTS: SshTimeouts = {
  connectMs: 20_000,
  commandMs: 60_000,
  discoveryMs: 120_000,
};
const MAX_LINE_BYTES = 16_384;
const CERT_VALIDITY_SECONDS = 3600;
const KEY_VERSION = 1;
const ACTOR = { type: "system" } as const;
const ADMIN_EMAIL = "admin@noodara.dev";
const SERVER_EMAIL = "ops@noodara.dev";
const FOREIGN_LISTENER = "noodara-test-foreign-80";
type DeployConnectModule =
  typeof import("../../../apps/control-plane/src/deploy/deploy-connect.js");
type ProxyJobModule =
  typeof import("../../../apps/control-plane/src/proxy/proxy-job.js");
type ProxyServiceModule =
  typeof import("../../../apps/control-plane/src/proxy/proxy-service.js");
type ProxyWiringModule =
  typeof import("../../../apps/control-plane/src/proxy/proxy-wiring.js");
type HttpErrorsModule =
  typeof import("../../../apps/control-plane/src/routes/http-errors.js");
type CredentialStoreModule =
  typeof import("../../../apps/control-plane/src/services/credential-store.js");

const LISTEN_JS = `require('net').createServer(() => {}).listen(Number(process.argv[1]), '0.0.0.0');
process.on('SIGTERM', () => process.exit(0));`;

interface LoggedLine {
  readonly level: string;
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function viewOf(result: ProxyServiceResult): ServerView {
  if (!result.ok) throw new Error(`proxy service failed: ${result.code}`);
  return result.server;
}

describe.each(DEPLOY_ENGINE_UBUNTU_VERSIONS)(
  "22-02 proxy lifecycle on Ubuntu %s",
  (ubuntu) => {
    let stack: DeployEngineStack | undefined;
    let postgres: PostgresFixture | undefined;
    let pebble: StartedPebble | undefined;
    let tempRoot: string | undefined;
    let nodeImage = "";
    let serverId = "";
    let handler: ((data: unknown) => Promise<string>) | undefined;
    let buildHandler: ((image: string) => (data: unknown) => Promise<string>) | undefined;
    let serviceDeps: ProxyServiceDeps | undefined;
    let proxyService: ProxyServiceModule | undefined;
    let httpErrors: HttpErrorsModule | undefined;

    const masterKey = randomBytes(32);
    const enqueued: ProxyInstallJobPayload[] = [];
    const events: ServerEvent[] = [];
    const logged: LoggedLine[] = [];

    const s = (): DeployEngineStack => {
      if (stack === undefined) throw new Error("stack not started");
      return stack;
    };
    const db = (): PostgresFixture["db"] => {
      if (postgres === undefined) throw new Error("postgres not started");
      return postgres.db;
    };
    const deps = (): ProxyServiceDeps => {
      if (serviceDeps === undefined) throw new Error("service deps not built");
      return serviceDeps;
    };
    const svc = (): ProxyServiceModule => {
      if (proxyService === undefined) throw new Error("modules not loaded");
      return proxyService;
    };
    const statusOf = (code: string): number => {
      if (httpErrors === undefined) throw new Error("modules not loaded");
      return httpErrors.mapServiceCodeToStatus(code);
    };
    const root = (argv: readonly string[]) => s().exec(argv, { user: "root" });
    const rootOut = async (argv: readonly string[]): Promise<string> => {
      const result = await root(argv);
      if (result.exitCode !== 0)
        throw new Error(
          `root exec failed (${String(result.exitCode)}): ${argv.join(" ")}`,
        );
      return result.stdout;
    };
    const exists = async (argv: readonly string[]): Promise<boolean> =>
      (await root(argv)).exitCode === 0;
    const proxyContainers = async (): Promise<string[]> =>
      (
        await rootOut([
          "docker",
          "ps",
          "--all",
          "--filter",
          `name=^/${proxyContainerName()}$`,
          "--format",
          "{{.ID}} {{.State}}",
        ])
      )
        .trim()
        .split("\n")
        .filter((line) => line !== "");
    const staticConfig = (): Promise<string> =>
      rootOut(["cat", PROXY_LAYOUT.staticConfigFile]);
    const serverRow = async () => {
      const [row] = await db()
        .select()
        .from(servers)
        .where(eq(servers.id, serverId))
        .limit(1);
      if (!row) throw new Error("server row missing");
      return row;
    };
    const activity = () =>
      db()
        .select()
        .from(activityEvents)
        .where(eq(activityEvents.entityId, serverId))
        .orderBy(asc(activityEvents.occurredAt));
    const proxyActivity = async (action: string) =>
      (await activity()).filter((event) => event.action === action);

    /** POST /api/servers/:id/proxy, then the worker runs the captured job. */
    const install = async (
      acmeEmail?: string,
    ): Promise<{ outcome: string; payload: ProxyInstallJobPayload }> => {
      if (handler === undefined) throw new Error("handler not built");
      const before = enqueued.length;
      const view = viewOf(
        await svc().requestProxyInstall(deps(), {
          actor: ACTOR,
          serverId,
          ...(acmeEmail === undefined ? {} : { acmeEmail }),
        }),
      );
      expect(view.proxyStatus).toBe("INSTALLING");
      expect(enqueued).toHaveLength(before + 1);
      const payload = enqueued[before];
      if (payload === undefined) throw new Error("no payload enqueued");
      return { outcome: await handler(payload), payload };
    };

    beforeAll(async () => {
      const starts = await Promise.allSettled([
        startDeployEngineStack({ ubuntu }),
        startPostgres(),
      ]);
      const [stackResult, pgResult] = starts;
      if (stackResult.status === "fulfilled") stack = stackResult.value;
      if (pgResult.status === "fulfilled") postgres = pgResult.value;
      const failed = starts.find((result) => result.status === "rejected");
      if (failed !== undefined) throw failed.reason;
      process.env.NOODARA_MASTER_KEY = masterKey.toString("base64");
      process.env.BETTER_AUTH_SECRET = `proxy-lifecycle-${randomUUID()}-${randomUUID()}`;
      process.env.DATABASE_URL = postgres?.connectionString ?? "";
      // Parsed only: nothing in this suite opens a Redis connection (the queue is a fake).
      process.env.REDIS_URL = "redis://127.0.0.1:6379";
      process.env.NOODARA_PUBLIC_URL = "http://localhost:3000";
      const deployConnect: DeployConnectModule =
        await import("../../../apps/control-plane/src/deploy/deploy-connect.js");
      const proxyJob: ProxyJobModule =
        await import("../../../apps/control-plane/src/proxy/proxy-job.js");
      const proxyWiring: ProxyWiringModule =
        await import("../../../apps/control-plane/src/proxy/proxy-wiring.js");
      const credentialStore: CredentialStoreModule =
        await import("../../../apps/control-plane/src/services/credential-store.js");
      proxyService =
        await import("../../../apps/control-plane/src/proxy/proxy-service.js");
      httpErrors =
        await import("../../../apps/control-plane/src/routes/http-errors.js");

      pebble = await startPebble({
        networkName: s().networkName,
        validitySeconds: CERT_VALIDITY_SECONDS,
      });

      const node = s().baseImages.find((ref) => ref.startsWith("node:"));
      if (node === undefined) throw new Error("no node base image preloaded");
      nodeImage = node;
      tempRoot = mkdtempSync(path.join(tmpdir(), "noodara-proxy-lifecycle-"));
      const caRootFile = path.join(tempRoot, "ca-root.pem");
      writeFileSync(caRootFile, pebble.listenerRootPem, { mode: 0o600 });

      // Server row: CONNECTED, Docker present, fingerprint pinned from a first trusted connect; the
      // admin (first user) supplies the default ACME email.
      const probe = await createSsh2Adapter().connect({
        target: { host: s().ssh.host, port: s().ssh.port, user: s().ssh.user },
        credential: {
          kind: "private_key",
          privateKey: secretValue(s().ssh.privateKey, "ssh_private_key"),
        },
        timeouts: TIMEOUTS,
        trustedFingerprint: null,
        redactor: createRedactor(),
      });
      if (!probe.ok)
        throw new Error(`fingerprint probe failed: ${probe.errorCode}`);
      const fingerprint = formatFingerprint(probe.fingerprint);
      await probe.session.close();
      const encoded = credentialStore.encodeCredential(
        { kind: "private_key", privateKey: s().ssh.privateKey },
        { key: masterKey, version: KEY_VERSION },
        createRedactor(),
      );
      if (!encoded.ok)
        throw new Error(`server credential rejected: ${encoded.code}`);
      const [credentialRow] = await db()
        .insert(credentials)
        .values({
          type: encoded.type,
          encryptedValue: encoded.encryptedValue,
          keyVersion: encoded.keyVersion,
        })
        .returning({ id: credentials.id });
      if (!credentialRow) throw new Error("credential insert returned no row");
      const [serverRowInserted] = await db()
        .insert(servers)
        .values({
          name: `proxy-host-${ubuntu}`,
          host: s().ssh.host,
          sshPort: s().ssh.port,
          sshUser: s().ssh.user,
          credentialId: credentialRow.id,
          status: "CONNECTED",
          hostFingerprint: fingerprint,
          dockerInstalled: true,
        })
        .returning({ id: servers.id });
      if (!serverRowInserted) throw new Error("server insert returned no row");
      serverId = serverRowInserted.id;
      await db().insert(users).values({ name: "Admin", email: ADMIN_EMAIL });

      const recordingEvents = {
        publish(event: ServerEvent): Promise<void> {
          events.push(event);
          return Promise.resolve();
        },
      };
      const logger = {
        info: (fields: Record<string, unknown>, message: string) =>
          logged.push({ level: "info", fields, message }),
        warn: (fields: Record<string, unknown>, message: string) =>
          logged.push({ level: "warn", fields, message }),
        error: (fields: Record<string, unknown>, message: string) =>
          logged.push({ level: "error", fields, message }),
      };
      const ssh = createSsh2Adapter();
      const masterKeys = () => Promise.resolve({ current: masterKey });
      const pebbleIp = pebble.ip;
      buildHandler = (image: string) =>
        proxyJob.createProxyInstallJobHandler(
        proxyWiring.createProxyInstallJobDeps({
          db: db(),
          events: recordingEvents,
          ssh,
          timeouts: TIMEOUTS,
          masterKeys,
          image,
          acmeCaUrl: PEBBLE_ACME_DIRECTORY_URL,
          acmeCaRootFile: caRootFile,
          maxLineBytes: MAX_LINE_BYTES,
          logger,
          extraHosts: [{ name: PEBBLE_HOSTNAME, ip: pebbleIp }],
        }),
      );
      handler = buildHandler(TRAEFIK_IMAGE);
      serviceDeps = {
        db: db(),
        now: () => new Date(),
        events: recordingEvents,
        enqueue: (payload) => {
          enqueued.push(payload);
          return Promise.resolve({
            ok: true,
            jobId: payload.jobId,
            collapsed: false,
          });
        },
        acmeCaUrl: PEBBLE_ACME_DIRECTORY_URL,
        remove: proxyWiring.createProxyRemover({
          loadServer: deployConnect.loadDeployServerFromDb(db()),
          ssh,
          timeouts: TIMEOUTS,
          masterKeys,
          limits: { stepMs: TIMEOUTS.commandMs, maxLineBytes: MAX_LINE_BYTES },
        }),
        removeTimeoutMs: proxyWiring.proxyRemoveTimeoutMs(TIMEOUTS),
      };
    }, STACK_TIMEOUT_MS);

    afterAll(async () => {
      await pebble?.stop();
      await postgres?.stop();
      await stack?.stop();
      if (tempRoot !== undefined)
        rmSync(tempRoot, { recursive: true, force: true });
      await assertNoStrayTestContainers();
    }, STACK_TIMEOUT_MS);

    it(
      "A1/A5: port 80 held by a foreign process fails PROXY_PORT_IN_USE naming it and leaves no proxy container",
      async () => {
        const started = await root([
          "docker",
          "run",
          "--detach",
          "--pull",
          "never",
          "--name",
          FOREIGN_LISTENER,
          "--network",
          "host",
          "--",
          nodeImage,
          "node",
          "-e",
          LISTEN_JS,
          "80",
        ]);
        expect(started.exitCode, started.stderr).toBe(0);
        const deadline = Date.now() + 20_000;
        while (
          !(await exists(["sh", "-c", `ss -ltnH 'sport = :80' | grep -q .`]))
        ) {
          if (Date.now() > deadline)
            throw new Error("foreign listener on :80 never came up");
          await delay(250);
        }

        const { outcome, payload } = await install();
        expect(outcome).toBe("failed");
        // H3: the payload carries only the server id, the ACME email (the admin's) and the job id.
        expect(Object.keys(payload).sort()).toEqual([
          "acmeEmail",
          "jobId",
          "serverId",
        ]);
        expect(payload).toEqual({
          serverId,
          acmeEmail: ADMIN_EMAIL,
          jobId: `proxy-install-${serverId}`,
        });

        const row = await serverRow();
        expect(row.proxyStatus).toBe("FAILED");
        expect(row.proxyErrorCode).toBe("PROXY_PORT_IN_USE");
        const [failure] = await proxyActivity("server.proxy_failed");
        expect(failure).toMatchObject({
          outcome: "failure",
          errorCode: "PROXY_PORT_IN_USE",
          metadata: { port: 80, listener: "node", trigger: "install" },
        });
        expect(await proxyContainers()).toEqual([]);
        const lastEvent = events.at(-1);
        expect(lastEvent).toMatchObject({
          type: "server.updated",
          server: {
            proxyStatus: "FAILED",
            proxyErrorCode: "PROXY_PORT_IN_USE",
          },
        });

        await rootOut(["docker", "rm", "--force", "--", FOREIGN_LISTENER]);
        await expectRemoteMatchesDatabase({ exec: root, db: db(), serverId });
      },
      INSTALL_CASE_TIMEOUT_MS,
    );

    it(
      "A1/A2/A5: the retry from FAILED installs, verifies the API and ends RUNNING with the ACME email in the static config",
      async () => {
        const { outcome } = await install();
        expect(outcome).toBe("installed");

        const row = await serverRow();
        expect(row.proxyStatus).toBe("RUNNING");
        expect(row.proxyErrorCode).toBeNull();
        expect(row.proxyInstalledAt).toBeInstanceOf(Date);
        const containers = await proxyContainers();
        expect(containers).toHaveLength(1);
        expect(containers[0]).toMatch(/ running$/);

        const config = await staticConfig();
        expect(config).toContain(ADMIN_EMAIL);
        expect(config).toContain(PEBBLE_ACME_DIRECTORY_URL);
        const modes = await rootOut([
          "stat",
          "-c",
          "%a",
          PROXY_LAYOUT.staticConfigFile,
          `${PROXY_LAYOUT.caDir}/ca-root.pem`,
        ]);
        expect(modes.trim().split("\n")).toEqual(["600", "600"]);
        expect(
          await rootOut(["cat", `${PROXY_LAYOUT.caDir}/ca-root.pem`]),
        ).toBe(pebble?.listenerRootPem);

        const [installed] = await proxyActivity("server.proxy_installed");
        expect(installed).toMatchObject({
          outcome: "success",
          metadata: { reinstalled: false, trigger: "install" },
        });
        expect(events.at(-1)).toMatchObject({
          type: "server.updated",
          server: { proxyStatus: "RUNNING", proxyErrorCode: null },
        });
        await expectRemoteMatchesDatabase({ exec: root, db: db(), serverId });
      },
      INSTALL_CASE_TIMEOUT_MS,
    );

    it(
      "A2: re-install on a RUNNING proxy is idempotent: RUNNING again, one container, reinstalled recorded",
      async () => {
        const { outcome } = await install();
        expect(outcome).toBe("installed");
        expect((await serverRow()).proxyStatus).toBe("RUNNING");
        const containers = await proxyContainers();
        expect(containers).toHaveLength(1);
        expect(containers[0]).toMatch(/ running$/);
        const installs = await proxyActivity("server.proxy_installed");
        expect(installs).toHaveLength(2);
        expect(installs[1]).toMatchObject({ metadata: { reinstalled: true } });
      },
      INSTALL_CASE_TIMEOUT_MS,
    );

    it(
      "22-07 A1: a pre-create fault (pull) on a RUNNING proxy fails the attempt but leaves noodara-traefik running",
      async () => {
        if (buildHandler === undefined) throw new Error("handler not built");
        const before = (await proxyContainers())[0];
        expect(before).toMatch(/ running$/);
        // A digest no registry serves: the pull step fails after ports/prepare_dirs/write_config ran.
        const faulty = buildHandler(`traefik:v3.7.14@sha256:${"0".repeat(64)}`);
        const queued = enqueued.length;
        viewOf(await svc().requestProxyInstall(deps(), { actor: ACTOR, serverId }));
        const payload = enqueued[queued];
        if (payload === undefined) throw new Error("no payload enqueued");
        expect(await faulty(payload)).not.toBe("installed");
        expect(await serverRow()).toMatchObject({
          proxyStatus: "FAILED",
          proxyErrorCode: "PROXY_INSTALL_FAILED",
        });
        const [failure] = (await proxyActivity("server.proxy_failed")).slice(-1);
        expect(failure).toMatchObject({ metadata: { step: "pull" } });
        // Same container (same id), still running and still answering on the entrypoint.
        expect(await proxyContainers()).toEqual([before]);

        // The retry with the real image ends RUNNING again.
        const { outcome } = await install();
        expect(outcome).toBe("installed");
        expect((await serverRow()).proxyStatus).toBe("RUNNING");
      },
      INSTALL_CASE_TIMEOUT_MS,
    );

    it(
      "22-07 A2: the boot sweep keys on the install start, so an updated_at bump cannot keep a stale install alive",
      async () => {
        const wiring: ProxyWiringModule =
          await import("../../../apps/control-plane/src/proxy/proxy-wiring.js");
        const credentialId = (await serverRow()).credentialId;
        const started = new Date(Date.now() - 3_600_000);
        const insertInstalling = async (name: string, sshPort: number, installStartedAt: Date | null) => {
          const [row] = await db()
            .insert(servers)
            .values({
              name,
              host: "203.0.113.10",
              sshPort,
              sshUser: "root",
              credentialId,
              status: "CONNECTED",
              proxyStatus: "INSTALLING",
              proxyInstallStartedAt: installStartedAt,
            })
            .returning({ id: servers.id });
          if (!row) throw new Error("server insert returned no row");
          return row.id;
        };
        const staleId = await insertInstalling(`sweep-stale-${ubuntu}`, 2201, started);
        const freshId = await insertInstalling(`sweep-fresh-${ubuntu}`, 2202, new Date());
        const legacyId = await insertInstalling(`sweep-legacy-${ubuntu}`, 2203, null);
        // A discovery/connect write bumps updated_at on the stale row: it must not extend the install.
        await db().update(servers).set({ updatedAt: new Date() }).where(eq(servers.id, staleId));

        const sweepEvents: ServerEvent[] = [];
        const failed = await wiring.sweepStaleProxyInstalls({
          db: db(),
          now: () => new Date(),
          events: { publish: (event: ServerEvent) => { sweepEvents.push(event); return Promise.resolve(); } },
          isPending: (id) => Promise.resolve(id === freshId || id === staleId),
          budgetMs: 600_000,
          logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
        });
        expect([...failed].sort()).toEqual([staleId, legacyId].sort());
        const rows = await db()
          .select({ id: servers.id, status: servers.proxyStatus, code: servers.proxyErrorCode })
          .from(servers);
        const byId = new Map(rows.map((row) => [row.id, row]));
        expect(byId.get(staleId)).toMatchObject({ status: "FAILED", code: "PROXY_INSTALL_FAILED" });
        expect(byId.get(legacyId)).toMatchObject({ status: "FAILED", code: "PROXY_INSTALL_FAILED" });
        expect(byId.get(freshId)).toMatchObject({ status: "INSTALLING", code: null });
        expect(sweepEvents).toHaveLength(2);
        const sweepRows = await db()
          .select()
          .from(activityEvents)
          .where(eq(activityEvents.entityId, staleId));
        expect(sweepRows).toMatchObject([{ action: "server.proxy_failed", metadata: { trigger: "sweep" } }]);

        await db().delete(servers).where(eq(servers.id, staleId));
        await db().delete(servers).where(eq(servers.id, freshId));
        await db().delete(servers).where(eq(servers.id, legacyId));
      },
      CASE_TIMEOUT_MS,
    );

    it(
      "A2: PATCH proxyAcmeEmail on a RUNNING proxy re-renders the static config with the server email",
      async () => {
        const before = enqueued.length;
        const patched = viewOf(
          await svc().setProxyAcmeEmail(deps(), {
            actor: ACTOR,
            serverId,
            acmeEmail: SERVER_EMAIL,
          }),
        );
        expect(patched).toMatchObject({
          proxyStatus: "INSTALLING",
          proxyAcmeEmail: SERVER_EMAIL,
        });
        const payload = enqueued[before];
        expect(payload).toEqual({
          serverId,
          acmeEmail: SERVER_EMAIL,
          jobId: `proxy-install-${serverId}`,
        });
        if (handler === undefined || payload === undefined)
          throw new Error("no job to run");
        expect(await handler(payload)).toBe("installed");

        const row = await serverRow();
        expect(row).toMatchObject({
          proxyStatus: "RUNNING",
          proxyAcmeEmail: SERVER_EMAIL,
        });
        const config = await staticConfig();
        expect(config).toContain(SERVER_EMAIL);
        expect(config).not.toContain(ADMIN_EMAIL);
      },
      INSTALL_CASE_TIMEOUT_MS,
    );

    it(
      "A5/H3: no credential reaches the static config, the payloads, the logs, the activity metadata or the events",
      async () => {
        const privateKey = s().ssh.privateKey;
        const keyBody = privateKey
          .split("\n")
          .filter((line) => line !== "" && !line.startsWith("-----"))
          .sort((a, b) => b.length - a.length)[0];
        if (keyBody === undefined) throw new Error("canary key has no body");
        const canaries = [
          privateKey.trim(),
          keyBody,
          masterKey.toString("base64"),
          masterKey.toString("hex"),
        ];

        const config = await staticConfig();
        const surfaces = {
          config,
          payloads: JSON.stringify(enqueued),
          logs: JSON.stringify(logged),
          activity: JSON.stringify(
            (await activity()).map((event) => ({
              errorCode: event.errorCode,
              metadata: event.metadata,
            })),
          ),
          events: JSON.stringify(events),
        };
        for (const [surface, text] of Object.entries(surfaces)) {
          for (const canary of canaries)
            expect(text.includes(canary), `${surface} leaks a credential`).toBe(
              false,
            );
          expect(text, surface).not.toMatch(/PRIVATE KEY/);
        }
        expect(config).toContain(SERVER_EMAIL);
      },
      CASE_TIMEOUT_MS,
    );

    it(
      "A3: remove answers PROXY_IN_USE (409) while a domain exists on the server, then removes container and files",
      async () => {
        const now = new Date();
        const [project] = await db()
          .insert(projects)
          .values({
            name: "proxy-lifecycle",
            slug: `proxy-${randomUUID().slice(0, 8)}`,
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: projects.id });
        if (!project) throw new Error("project insert returned no row");
        const [environment] = await db()
          .insert(environments)
          .values({
            projectId: project.id,
            name: "production",
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: environments.id });
        if (!environment) throw new Error("environment insert returned no row");
        const [service] = await db()
          .insert(services)
          .values({
            projectId: project.id,
            environmentId: environment.id,
            serverId,
            name: "api",
            sourceType: "image",
            imageRef: "nginx:1.27",
            internalPort: 80,
          })
          .returning({ id: services.id });
        if (!service) throw new Error("service insert returned no row");
        const [domain] = await db()
          .insert(domains)
          .values({
            projectId: project.id,
            serviceId: service.id,
            hostname: `a${randomUUID().slice(0, 8)}.proxy.noodara.test`,
          })
          .returning({ id: domains.id });
        if (!domain) throw new Error("domain insert returned no row");

        const inUse = await svc().removeServerProxy(deps(), {
          actor: ACTOR,
          serverId,
        });
        expect(inUse).toMatchObject({ ok: false, code: "PROXY_IN_USE" });
        if (inUse.ok) throw new Error("unreachable");
        expect(statusOf(inUse.code)).toBe(409);
        expect((await serverRow()).proxyStatus).toBe("RUNNING");
        expect(await proxyContainers()).toHaveLength(1);

        await db().delete(domains).where(eq(domains.id, domain.id));
        const removed = viewOf(
          await svc().removeServerProxy(deps(), { actor: ACTOR, serverId }),
        );
        expect(removed).toMatchObject({
          proxyStatus: "NOT_INSTALLED",
          proxyErrorCode: null,
          proxyInstalledAt: null,
        });
        expect(await proxyContainers()).toEqual([]);
        expect(await exists(["test", "-e", PROXY_LAYOUT.root])).toBe(false);
        const [removal] = await proxyActivity("server.proxy_removed");
        expect(removal).toMatchObject({
          outcome: "success",
          metadata: { trigger: "request" },
        });

        // Removing an absent proxy is a no-op that still answers NOT_INSTALLED.
        expect(
          viewOf(
            await svc().removeServerProxy(deps(), { actor: ACTOR, serverId }),
          ).proxyStatus,
        ).toBe("NOT_INSTALLED");
        expect(await proxyActivity("server.proxy_removed")).toHaveLength(1);
      },
      CASE_TIMEOUT_MS,
    );
  },
);
