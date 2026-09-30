import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../../apps/control-plane/src/db/client.js";
import { startPostgres, type PostgresFixture } from "../helpers/postgres.js";

// Phase 11 (plan 11-05): the database itself enforces project ownership (PROJ-04), one active
// deployment per service (ROADMAP D16) and the credential/server RESTRICT order (D-17, PROJ-05).
// Raw SQL on purpose: these guarantees must hold even for a caller that bypasses every service.

interface PgErrorShape {
  readonly code?: string;
  readonly constraint?: string;
}

/** drizzle wraps driver errors (DrizzleQueryError.cause); unwrap to the pg error. */
function pgErrorOf(error: unknown): PgErrorShape {
  let current: unknown = error;
  for (
    let depth = 0;
    depth < 5 && current !== null && typeof current === "object";
    depth += 1
  ) {
    const candidate = current as {
      code?: unknown;
      constraint?: unknown;
      cause?: unknown;
    };
    if (typeof candidate.code === "string") {
      return {
        code: candidate.code,
        constraint:
          typeof candidate.constraint === "string"
            ? candidate.constraint
            : undefined,
      };
    }
    current = candidate.cause;
  }
  return {};
}

async function expectPgError(
  action: Promise<unknown>,
  code: string,
  constraint?: string,
): Promise<void> {
  let caught: unknown;
  try {
    await action;
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected SQLSTATE ${code}`).toBeDefined();
  const pgError = pgErrorOf(caught);
  expect(pgError.code).toBe(code);
  if (constraint !== undefined) {
    expect(pgError.constraint).toBe(constraint);
  }
}

let fixture: PostgresFixture | undefined;

function db(): Database {
  if (fixture === undefined) throw new Error("postgres fixture not started");
  return fixture.db;
}

beforeAll(async () => {
  fixture = await startPostgres();
});

afterAll(async () => {
  await fixture?.stop();
  fixture = undefined;

  // noodara-tdd skill §5: no stray container labelled noodara.test=true survives a run.
  const { getContainerRuntimeClient } = await import("testcontainers");
  const client = await getContainerRuntimeClient();
  const containers = await client.container.list();
  const stray = containers.filter(
    (container) => container.Labels["noodara.test"] === "true",
  );
  expect(stray).toHaveLength(0);
});

function unique(prefix: string): string {
  return `${prefix}-${uuidv7().slice(-12)}`;
}

async function insertSshCredential(): Promise<string> {
  const id = uuidv7();
  await db().execute(sql`
    insert into credentials (id, type, encrypted_value, key_version)
    values (${id}, 'ssh_password', 'v1:nonce:cipher:tag', 1)
  `);
  return id;
}

let serverCounter = 0;

async function insertServer(): Promise<string> {
  const credentialId = await insertSshCredential();
  const id = uuidv7();
  serverCounter += 1;
  await db().execute(sql`
    insert into servers (id, name, host, ssh_port, ssh_user, credential_id)
    values (${id}, ${unique("srv")}, '10.1.0.1', ${10_000 + serverCounter}, 'root', ${credentialId})
  `);
  return id;
}

async function insertProject(): Promise<string> {
  const id = uuidv7();
  const name = unique("project");
  await db().execute(
    sql`insert into projects (id, name, slug) values (${id}, ${name}, ${name})`,
  );
  return id;
}

async function insertEnvironment(
  projectId: string,
  name = "production",
): Promise<string> {
  const id = uuidv7();
  await db().execute(
    sql`insert into environments (id, project_id, name) values (${id}, ${projectId}, ${name})`,
  );
  return id;
}

interface ServiceInsert {
  readonly projectId: string;
  readonly environmentId: string;
  readonly serverId: string;
  readonly repositoryCredentialId?: string | null;
  readonly registryCredentialId?: string | null;
}

function insertImageService(
  input: ServiceInsert,
  id = uuidv7(),
): Promise<unknown> {
  return db().execute(sql`
    insert into services (id, project_id, environment_id, server_id, name, source_type, image_ref,
      internal_port, repository_credential_id, registry_credential_id)
    values (${id}, ${input.projectId}, ${input.environmentId}, ${input.serverId}, ${unique("svc")},
      'image', 'nginx:1.27-alpine', 80, ${input.repositoryCredentialId ?? null},
      ${input.registryCredentialId ?? null})
  `);
}

async function createService(input: Partial<ServiceInsert> = {}): Promise<{
  serviceId: string;
  projectId: string;
  environmentId: string;
  serverId: string;
}> {
  const projectId = input.projectId ?? (await insertProject());
  const environmentId =
    input.environmentId ?? (await insertEnvironment(projectId));
  const serverId = input.serverId ?? (await insertServer());
  const serviceId = uuidv7();
  await insertImageService(
    { ...input, projectId, environmentId, serverId },
    serviceId,
  );
  return { serviceId, projectId, environmentId, serverId };
}

async function insertDeployment(
  serviceId: string,
  status = "QUEUED",
): Promise<string> {
  const id = uuidv7();
  await db().execute(sql`
    insert into deployments (id, service_id, status, source)
    values (${id}, ${serviceId}, ${status}::deployment_status, ${JSON.stringify({ type: "image" })}::jsonb)
  `);
  return id;
}

function tryInsertDeployment(
  serviceId: string,
  status: string,
): Promise<unknown> {
  return db().execute(sql`
    insert into deployments (id, service_id, status, source)
    values (${uuidv7()}, ${serviceId}, ${status}::deployment_status, '{}'::jsonb)
  `);
}

async function countRows(
  table: string,
  column: string,
  value: string,
): Promise<number> {
  const result = await db().execute<{ count: number }>(
    sql`select count(*)::int as count from ${sql.identifier(table)} where ${sql.identifier(column)} = ${value}`,
  );
  return result.rows[0]?.count ?? -1;
}

describe("project ownership at the database (PROJ-04)", () => {
  it("rejects a service whose environment belongs to another project (23503)", async () => {
    const projectA = await insertProject();
    const projectB = await insertProject();
    await insertEnvironment(projectA);
    const envB1 = await insertEnvironment(projectB);
    const serverId = await insertServer();

    await expectPgError(
      insertImageService({
        projectId: projectA,
        environmentId: envB1,
        serverId,
      }),
      "23503",
      "services_environment_project_fk",
    );
  });

  it("accepts a service whose environment belongs to the same project", async () => {
    const projectA = await insertProject();
    const envA1 = await insertEnvironment(projectA);
    const serverId = await insertServer();

    await insertImageService({
      projectId: projectA,
      environmentId: envA1,
      serverId,
    });

    expect(await countRows("services", "environment_id", envA1)).toBe(1);
  });

  it("rejects an environment for a project that does not exist (23503)", async () => {
    await expectPgError(insertEnvironment(uuidv7()), "23503");
  });

  it("rejects two environments whose names differ only by case in one project (23505)", async () => {
    const projectId = await insertProject();
    await insertEnvironment(projectId, "Production");

    await expectPgError(
      insertEnvironment(projectId, "production"),
      "23505",
      "environments_project_name_lower_unique_idx",
    );
  });

  it("accepts the same environment name in two different projects", async () => {
    const projectA = await insertProject();
    const projectB = await insertProject();

    await insertEnvironment(projectA, "staging");
    await insertEnvironment(projectB, "staging");

    expect(await countRows("environments", "project_id", projectB)).toBe(1);
  });
});

describe("one active deployment per service (ROADMAP D16)", () => {
  it.each(["QUEUED", "PREPARING", "BUILDING", "DEPLOYING"])(
    "rejects a second %s deployment while one is QUEUED (23505)",
    async (status) => {
      const { serviceId } = await createService();
      await insertDeployment(serviceId, "QUEUED");

      await expectPgError(
        tryInsertDeployment(serviceId, status),
        "23505",
        "deployments_service_active_unique_idx",
      );
    },
  );

  it.each(["SUCCESS", "FAILED", "CANCELLED"])(
    "accepts a new QUEUED deployment once the previous one reached %s",
    async (terminal) => {
      const { serviceId } = await createService();
      const firstId = await insertDeployment(serviceId, "QUEUED");
      await db().execute(
        sql`update deployments set status = ${terminal}::deployment_status where id = ${firstId}`,
      );

      await insertDeployment(serviceId, "QUEUED");

      expect(await countRows("deployments", "service_id", serviceId)).toBe(2);
    },
  );

  it("lets two different services each hold one active deployment", async () => {
    const first = await createService();
    const second = await createService();

    await insertDeployment(first.serviceId, "BUILDING");
    await insertDeployment(second.serviceId, "BUILDING");

    expect(await countRows("deployments", "service_id", second.serviceId)).toBe(
      1,
    );
  });

  it("rejects a duplicate (deployment_id, phase, seq) log chunk (23505)", async () => {
    const { serviceId } = await createService();
    const deploymentId = await insertDeployment(serviceId);
    const insertChunk = (): Promise<unknown> =>
      db().execute(sql`
        insert into deployment_log_chunks (id, deployment_id, phase, seq, content, byte_length)
        values (${uuidv7()}, ${deploymentId}, 'build', 1, 'step 1/3', 8)
      `);
    await insertChunk();

    await expectPgError(
      insertChunk(),
      "23505",
      "deployment_log_chunks_deployment_phase_seq_unique_idx",
    );
  });
});

describe("credentials for services (D-15..D-18)", () => {
  it("stores git_deploy_key (with public_key), git_https_token and registry_password rows", async () => {
    const deployKeyId = uuidv7();
    await db().execute(sql`
      insert into credentials (id, type, encrypted_value, key_version, public_key)
      values (${deployKeyId}, 'git_deploy_key', 'v1:n:c:t', 1, 'ssh-ed25519 AAAAC3Nza test')
    `);
    await db().execute(sql`
      insert into credentials (id, type, encrypted_value, key_version)
      values (${uuidv7()}, 'git_https_token', 'v1:n:c:t', 1),
             (${uuidv7()}, 'registry_password', 'v1:n:c:t', 1)
    `);

    const result = await db().execute<{ public_key: string | null }>(
      sql`select public_key from credentials where id = ${deployKeyId}`,
    );
    expect(result.rows[0]?.public_key).toBe("ssh-ed25519 AAAAC3Nza test");
  });

  it.each(["repository_credential_id", "registry_credential_id"] as const)(
    "rejects deleting a credential referenced by services.%s (23503)",
    async (column) => {
      const credentialId = await insertSshCredential();
      await createService(
        column === "repository_credential_id"
          ? { repositoryCredentialId: credentialId }
          : { registryCredentialId: credentialId },
      );

      await expectPgError(
        db().execute(sql`delete from credentials where id = ${credentialId}`),
        "23503",
      );
    },
  );

  it("deletes the service then its credential in one transaction (D-17 order)", async () => {
    const credentialId = await insertSshCredential();
    const { serviceId } = await createService({
      repositoryCredentialId: credentialId,
    });

    await db().transaction(async (tx) => {
      await tx.execute(sql`delete from services where id = ${serviceId}`);
      await tx.execute(sql`delete from credentials where id = ${credentialId}`);
    });

    expect(await countRows("credentials", "id", credentialId)).toBe(0);
  });
});

describe("restrict and cascade (PROJ-05 backstop)", () => {
  it("rejects deleting a server referenced by a service (23503)", async () => {
    const { serverId } = await createService();

    await expectPgError(
      db().execute(sql`delete from servers where id = ${serverId}`),
      "23503",
    );
  });

  it("cascades a project delete to environments, services, deployments and log chunks", async () => {
    const { projectId, environmentId, serviceId } = await createService();
    const deploymentId = await insertDeployment(serviceId);
    await db().execute(sql`
      insert into deployment_log_chunks (id, deployment_id, phase, seq, content, byte_length)
      values (${uuidv7()}, ${deploymentId}, 'prepare', 0, 'cloning', 7)
    `);

    await db().execute(sql`delete from projects where id = ${projectId}`);

    expect(await countRows("environments", "id", environmentId)).toBe(0);
    expect(await countRows("services", "id", serviceId)).toBe(0);
    expect(await countRows("deployments", "id", deploymentId)).toBe(0);
    expect(
      await countRows("deployment_log_chunks", "deployment_id", deploymentId),
    ).toBe(0);
  });
});

describe("service shape checks", () => {
  async function ownership(): Promise<{
    projectId: string;
    environmentId: string;
    serverId: string;
  }> {
    const projectId = await insertProject();
    const environmentId = await insertEnvironment(projectId);
    const serverId = await insertServer();
    return { projectId, environmentId, serverId };
  }

  it("rejects a git service without a branch (23514)", async () => {
    const o = await ownership();

    await expectPgError(
      db().execute(sql`
        insert into services (id, project_id, environment_id, server_id, name, source_type,
          repository_url, build_context, dockerfile_path, internal_port)
        values (${uuidv7()}, ${o.projectId}, ${o.environmentId}, ${o.serverId}, ${unique("svc")},
          'git', 'https://example.com/repo.git', '.', 'Dockerfile', 3000)
      `),
      "23514",
      "services_source_shape_check",
    );
  });

  it("accepts a complete git service", async () => {
    const o = await ownership();

    await db().execute(sql`
      insert into services (id, project_id, environment_id, server_id, name, source_type,
        repository_url, branch, build_context, dockerfile_path, internal_port)
      values (${uuidv7()}, ${o.projectId}, ${o.environmentId}, ${o.serverId}, ${unique("svc")},
        'git', 'https://example.com/repo.git', 'main', '.', 'Dockerfile', 3000)
    `);

    expect(await countRows("services", "environment_id", o.environmentId)).toBe(
      1,
    );
  });

  it("rejects an image service carrying a repository_url (23514)", async () => {
    const o = await ownership();

    await expectPgError(
      db().execute(sql`
        insert into services (id, project_id, environment_id, server_id, name, source_type,
          image_ref, repository_url, internal_port)
        values (${uuidv7()}, ${o.projectId}, ${o.environmentId}, ${o.serverId}, ${unique("svc")},
          'image', 'nginx:1.27-alpine', 'https://example.com/repo.git', 80)
      `),
      "23514",
      "services_source_shape_check",
    );
  });

  it.each([
    { label: "internal_port 0", internal: 0, published: null },
    { label: "published_port 70000", internal: 80, published: 70_000 },
  ])("rejects $label (23514)", async ({ internal, published }) => {
    const o = await ownership();

    await expectPgError(
      db().execute(sql`
        insert into services (id, project_id, environment_id, server_id, name, source_type,
          image_ref, internal_port, published_port)
        values (${uuidv7()}, ${o.projectId}, ${o.environmentId}, ${o.serverId}, ${unique("svc")},
          'image', 'nginx:1.27-alpine', ${internal}, ${published})
      `),
      "23514",
      "services_ports_range_check",
    );
  });
});

describe("column shape (DEP-08, ROADMAP D4)", () => {
  it("services has no build-args or env columns", async () => {
    const result = await db().execute<{ column_name: string }>(sql`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'services'
    `);
    const columns = result.rows.map((row) => row.column_name);

    expect(columns).toContain("internal_port");
    expect(
      columns.filter(
        (name) => /build_arg|env/.test(name) && name !== "environment_id",
      ),
    ).toEqual([]);
  });

  it("deployments carries nullable commit_sha, previous_deployment_id and duration_ms", async () => {
    const result = await db().execute<{
      column_name: string;
      is_nullable: string;
    }>(sql`
      select column_name, is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'deployments'
        and column_name in ('commit_sha', 'previous_deployment_id', 'duration_ms')
    `);

    expect(result.rows).toHaveLength(3);
    for (const row of result.rows) {
      expect(row.is_nullable, row.column_name).toBe("YES");
    }
  });
});
